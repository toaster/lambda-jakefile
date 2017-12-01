const fs = require('fs');
const $ = require('procstreams');
const Aws = require('aws-sdk');
const Tempy = require('tempy');

// jake's fail method is not suitable for promises
function promiseFail(e) {
  if (!(e instanceof Error)) {
    e = new Error(e);
  }
  jake.program.handleErr(e);
};

$.prototype.promise = function() {
  return new Promise((resolve, reject) => {
    this.data((err, stdout, stderr) => {
      if (err) {
        var msg = `${this.spawnargs.join(" ")} failed: ` + (
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

var _config;
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

var _definitions;
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

var _commit;
function commitPromise() {
  if (!_commit) {
    _commit = $("git rev-parse @").promise();
  }
  return _commit;
}

var _basedir;
function basedirPromise() {
  if (!_basedir) {
    _basedir = $("git rev-parse --show-toplevel").promise();
  }
  return _basedir;
}

function createPackage(name, packageJson) {
  return Promise.all([commitPromise(), basedirPromise()]).then(([commit, basedir]) => {
    var packagedir = `${basedir}/pkg`;
    var packagePath = `${packagedir}/${name}_${commit}.zip`;

    return new Promise((resolve, reject) => {
      if (fs.existsSync(packagePath)) {
        console.log(`Package already exists in ${packagePath}`);
        resolve();
      } else {
        if (!fs.existsSync(packagedir)) {
          fs.mkdirSync(packagedir);
        }
        let previousDir = process.cwd();
        process.chdir(Tempy.directory());
        let shellCommands = [
          `rsync -a ${basedir}/.git .`,
          `git reset --hard ${commit}`,
        ];
        if (packageJson) {
          shellCommands.push(`cp ${packageJson} package.json`);
        }
        shellCommands = shellCommands.concat([
          "npm install --production",
          "zip -rq package.zip index.js node_modules lib app",
          `cp package.zip ${packagePath}`,
        ])
        jake.exec(shellCommands, {printStdout: true, printStderr: true}, (...args) => {
          process.chdir(previousDir);
          console.log(`Package created in ${packagePath}`);
          resolve();
        });
      }
    }).then(() => {
      return {name: name, commit: commit, path: `${packagePath}`};
    });
  });
}

desc('Creates a package for upload to AWS.');
task('package', {async: true}, function () {
  var chain = Promise.resolve();
  var packages = {};
  for (let definition of deployDefinitions()) {
    chain = chain
        .then(() => createPackage(definition.functionName, definition.packageJson))
        .then(package => { packages[package.name] = package; });
  }
  chain.then(() => complete(packages)).catch(e => promiseFail(e));
});

class Cancel extends Error {
}

function performDeployment(FunctionName, force, aliasName) {
  console.log(`Deploying to ${FunctionName} in AWS profile ${Aws.config.credentials.profile}.`);

  var package = jake.Task['package'].value[FunctionName];
  var lambda = new Aws.Lambda({region: 'eu-west-1'});
  return lambda.listAliases({FunctionName}).promise().then((result) => {
    return result.Aliases.find((alias) => { return alias.Name === aliasName; });
  }).then((activeAlias) => {
    return lambda.listVersionsByFunction({FunctionName}).promise().then((result) => {
      var activeVersion = result.Versions.find(
          (version) => { return version.Version == activeAlias.FunctionVersion; });
      if (activeVersion.Description == package.commit && !force) {
        throw new Cancel(`Commit ${package.commit} is already deployed at ${FunctionName}.`);
      }
    });
  }).then(() => {
    return lambda.updateFunctionCode({
      FunctionName,
      ZipFile: fs.readFileSync(package.path)
    }).promise();
  }).then(() => {
    return lambda.publishVersion({FunctionName, Description: package.commit}).promise();
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
  if (!process.env.DRI_SLACK_WEBHOOK_URI) { throw "DRI_SLACK_WEBHOOK_URI is not set."; }

  const sleep = require('sleep-promise');
  const Path = require('path');

  console.log(`Now starting ${process.env.EDITOR} to edit the DRI announcement message…`);
  return Promise.all([
    config().slack_service_name,
    basedirPromise().then(basedir => Path.basename(basedir)),
    commitPromise(),
    $("git remote get-url origin").promise(),
    sleep(2000).then(() => {
      return new Promise((resolve, reject) => {
        var tmpFile = Tempy.file();
        jake.exec([`${process.env.EDITOR} ${tmpFile}`], {interactive: true}, () => {
          resolve(fs.readFileSync(tmpFile));
        });
      });
    }),
  ]).then(([slackServiceName, serviceName, commit, repoUrl, driMessage]) => {
    slackr = require('slackr');
    slackr.conf.uri = process.env.DRI_SLACK_WEBHOOK_URI;
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
        `<${commitUrl}|#${commit.substr(0, 8)}>: ${driMessage}`;
    return slackr.string(announcement).then(() => {
      console.log(`Sent DRI announcement: ${announcement}`);
    });
  }).catch((error) => {
    console.log(`Could not notify DRI channel: ${error}`);
    console.log("Don't forget to post an announcement there.");
  });
}

var _localConfig;
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
  var sts = new Aws.STS();
  return sts.getCallerIdentity().promise().then(({Account}) => Account);
}

desc("Deploys the package on AWS.");
task('deploy', ['package'], {async: true}, function(force, alias) {
  var deployments = [];
  for (let definition of deployDefinitions()) {
    deployments.push(performDeployment(definition.functionName, force, alias || 'active'));
  }
  Promise.all(deployments).then(deployed => {
    if (deployed.includes(true)) {
      return determineAccountId().then(accountId => {
        if (accountId != DEV_ACCOUNT_ID) {
          return sendDRINotification();
        }
      });
    }
  }).then(complete).catch(promiseFail);
});
