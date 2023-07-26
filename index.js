const fs = require('fs');
const Path = require('path');
const $p = require('procstreams');
const Aws = require('aws-sdk');
const Tempy = require('tempy');

//
//
// internal functions
//

// jake's fail method is not suitable for promises
function promiseFail(e) {
  if (!(e instanceof Error)) {
    e = new Error(e);
  }
  jake.program.handleErr(e);
}

$p.prototype.promise = function() {
  return new Promise((resolve, reject) => {
    this.data((err, stdout, stderr) => {
      if (err) {
        let msg = `${this.spawnargs.join(" ")} failed: ` + (
            (stderr && stderr.toString()) ||
            (stdout && stdout.toString()) ||
            `command failed: ${err.code}`
        );
        reject(new Error(msg));
      } else {
        resolve((stdout && stdout.toString().trim()) || "");
      }
    });
  });
};

let _config;
function config() {
  if (_config === undefined) {
    let path = "deploy.json";
    if (!fs.existsSync(path)) {
      fail(`You have to configure your deployments in ${path}.`);
    }
    _config = JSON.parse(fs.readFileSync(path));
  }
  return _config;
}

let _definitions;
function deployDefinitions() {
  if (!_definitions) {
    _definitions = config().deployments;
    if (!_definitions && config().functionName) {
      _definitions = [{functionName: config().functionName}];
    }
    if (!_definitions) {
      fail("Your deployment configuration neither contains “deployments” nor “functionName”.");
    }
  }
  return _definitions;
}

let _repositoryName;
function repositoryNamePromise() {
  if (!_repositoryName) {
    _repositoryName = $p("git remote get-url origin").promise().then(url => {
      return Path.basename(url.substring(0, url.length - Path.extname(url).length));
    });
  }
  return _repositoryName;
}

let _commit;
function commitPromise() {
  if (!_commit) {
    _commit = $p("git rev-parse @").promise();
  }
  return _commit;
}

const _projectDir = process.cwd();
function projectDir(options) {
  let dir = _projectDir;
  if (options && options.relativeTo) {
    dir = Path.relative(options.relativeTo, dir) || ".";
  }
  return dir;
}

let _baseDir;
function baseDirPromise() {
  if (!_baseDir) {
    _baseDir = $p("git rev-parse --show-toplevel").promise();
  }
  return _baseDir;
}

function createPackage(name, packageJson) {
  return buildPackagePromise((commit, packageDir, callback) => {
    let packagePath = `${packageDir}/${name}_${commit}.zip`;

    if (fs.existsSync(packagePath)) {
      console.log(`Package already exists in ${packagePath}`);
      callback({name: name, commit: commit, path: packagePath});
    } else {
      let shellCommands = [];
      if (packageJson) {
        shellCommands.push(`cp ${packageJson} package.json`);
      }
      shellCommands = shellCommands.concat([
        "npm install --production",
        "zip -rq package.zip *.js node_modules lib app",
        `cp package.zip ${packagePath}`,
      ])
      jake.exec(shellCommands, {printStdout: true, printStderr: true}, () => {
        console.log(`Package created in ${packagePath}`);
        callback({name: name, commit: commit, path: packagePath});
      });
    }
  });
}

function awsGatherAll(client, fnName, params) {
  return client[fnName](params).promise().then(result => {
    let keys = Object.keys(result).filter(key => key !== 'NextMarker');
    if (keys.length !== 1) {
      throw "could not gather all, result contains ambiguous keys";
    }
    let items = result[keys[0]];

    if (result.NextMarker) {
      newParams = {};
      Object.assign(newParams, params);
      newParams.Marker = result.NextMarker;
      return awsGatherAll(client, fnName, newParams).then(moreItems => items.concat(moreItems));
    } else {
      return items;
    }
  });
}

class Cancel extends Error {
}

function performDeployment(FunctionName, force, aliasName) {
  console.log(`Deploying to ${FunctionName} in AWS profile ${Aws.config.credentials.profile}.`);

  let pkg = jake.Task['package'].value[FunctionName];
  let lambda = new Aws.Lambda({region: Aws.config.region || 'eu-west-1'});
  return awsGatherAll(lambda, 'listAliases', {FunctionName}).then(aliases => {
    return aliases.find(alias => alias.Name === aliasName);
  }).then(activeAlias => {
    return awsGatherAll(lambda, 'listVersionsByFunction', {FunctionName}).then(versions => {
      let activeVersion = versions.find(version => version.Version === activeAlias.FunctionVersion);
      if (activeVersion.Description === pkg.commit && !force) {
        throw new Cancel(`Commit ${pkg.commit} is already deployed at ${FunctionName}.`);
      }
    });
  }).then(() => {
    return lambda.updateFunctionCode({
      FunctionName,
      ZipFile: fs.readFileSync(pkg.path)
    }).promise();
  }).then(() => {
    return lambda.waitFor("functionUpdated", {FunctionName}).promise();
  }).then(() => {
    return lambda.publishVersion({FunctionName, Description: pkg.commit}).promise();
  }).then((result) => {
    return lambda.updateAlias({
      FunctionName,
      Name: aliasName,
      FunctionVersion: result.Version,
    }).promise();
  }).then(() => {
    console.log(`Deployed ${FunctionName}.`);
    return true;
  }).catch(e => {
    if (e instanceof Cancel) {
      console.log(e.message);
      return false;
    } else {
      throw e;
    }
  });
}

function sendDRINotification() {
  if (!process.env.EDITOR) { throw "EDITOR is not set."; }

  const sleep = require('sleep-promise');

  console.log(`Now starting ${process.env.EDITOR} to edit the DRI announcement message…`);
  return Promise.all([
    config().slack_service_name,
    Promise.all([repositoryNamePromise(), baseDirPromise()]).then(([repositoryName, baseDir]) => {
      let projectName = projectDir({relativeTo: baseDir});
      return projectName !== "." ? `${repositoryName}/${projectName}` : repositoryName;
    }),
    commitPromise(),
    $p("git remote get-url origin").promise(),
    sleep(2000).then(() => {
      return new Promise((resolve) => {
        let tmpFile = Tempy.file();
        jake.exec([`${process.env.EDITOR} ${tmpFile}`], {interactive: true}, () => {
          resolve(fs.readFileSync(tmpFile));
        });
      });
    }),
  ]).then(([slackServiceName, serviceName, commit, repoUrl, driMessage]) => {
    if (repoUrl.startsWith("git@github.com:")) {
      repoUrl = `https://github.com/${repoUrl.slice(15)}`;
    }
    let commitUrl = repoUrl;
    if (repoUrl.startsWith("https://github.com")) {
      commitUrl = `${repoUrl}/commit/${commit}`;
    }
    let service = slackServiceName ? `:${slackServiceName}:` : `(${serviceName})`;
    let announcement = `:aws: :lambda: ${service} ` +
        `<@${process.env.SLACK_USER || process.env.USER}> deployed ` +
        `<${commitUrl}|#${commit.substring(0, 8)}>: ${driMessage}`;

    if (process.env.DRI_SLACK_WEBHOOK_URI) {
      const slackr = require('slackr');
      slackr.conf.uri = process.env.DRI_SLACK_WEBHOOK_URI;
      return slackr.string(announcement).then(() => {
        console.log(`Sent DRI announcement: ${announcement}`);
      });
    } else {
      console.log("DRI_SLACK_WEBHOOK_URI not set, could not send DRI announcement.");
      console.log("Please send it manually:", announcement);
    }
  }).catch((error) => {
    console.log(`Could not notify DRI channel: ${error}`);
    console.log("Don't forget to post an announcement there.");
  });
}

let _localConfig;
function localConfig() {
  if (_localConfig === undefined) {
    let path = `${process.env.HOME}/.config/infopark/aws_utils.json`;
    if (fs.existsSync(path)) {
      _localConfig = JSON.parse(fs.readFileSync(path));
    } else {
      _localConfig = {};
    }
  }
  return _localConfig;
}

const DEV_ACCOUNT_ID = process.env.DEV_ACCOUNT_ID ||
    process.env.INFOPARK_AWS_DEV_ACCOUNT_ID || localConfig().dev_account_id;
if (!DEV_ACCOUNT_ID) {
  console.warn("The AWS development account ID is not configured.");
}

function determineAccountId() {
  let sts = new Aws.STS();
  return sts.getCallerIdentity().promise().then(({Account}) => Account);
}


//
// exported functions
//

function buildPackagePromise(builder) {
  return Promise.all([commitPromise(), baseDirPromise()]).then(([commit, baseDir]) => {
    let packageDir = `${projectDir()}/pkg`;

    return new Promise((resolve, reject) => {
      if (!fs.existsSync(packageDir)) {
        fs.mkdirSync(packageDir);
      }
      let previousDir = process.cwd();
      process.chdir(Tempy.directory());
      jake.exec([
        `rsync -a ${baseDir}/.git .`,
        `git reset --hard ${commit}`,
      ], {printStdout: true, printStderr: true}, () => {
        process.chdir(projectDir({relativeTo: baseDir}));
        builder(commit, packageDir, (result, err) => {
          process.chdir(previousDir);
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      });
    });
  });
}

module.buildPackagePromise = buildPackagePromise;

//
// tasks
//

desc('Creates a package for upload to AWS.');
task('package', {async: true}, function () {
  let chain = Promise.resolve();
  let packages = {};
  for (let definition of deployDefinitions()) {
    chain = chain
        .then(() => createPackage(definition.functionName, definition.packageJson))
        .then(pkg => { packages[pkg.name] = pkg; });
  }
  chain.then(() => complete(packages)).catch(e => promiseFail(e));
});

desc("Deploys the package on AWS.");
task('deploy', ['package'], {async: true}, function(force, alias) {
  let deployments = [];
  for (let definition of deployDefinitions()) {
    deployments.push(performDeployment(definition.functionName, force, alias || 'active'));
  }
  Promise.all(deployments).then(deployed => {
    if (deployed.includes(true)) {
      return determineAccountId().then(accountId => {
        if (accountId !== DEV_ACCOUNT_ID) {
          return sendDRINotification();
        }
      });
    }
  }).then(complete).catch(promiseFail);
});
