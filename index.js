const fs = require('fs');
const $ = require('procstreams');
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

var _definitions;
function deployDefinitions() {
  if (!_definitions) {
    if (!fs.existsSync("deploy.json")) {
      fail("You have to configure your deployments in deploy.json.");
    }
    let config = JSON.parse(fs.readFileSync("deploy.json"));
    _definitions = config.deployments;
    if (!_definitions && config.functionName) {
      _definitions = [{functionName: config.functionName}];
    }
    if (!_definitions) {
      fail("Your deploy.json neither contains “deployments” nor “functionName”.");
    }
  }
  return _definitions;
}

function createPackage(name, packageJson) {
  return Promise.all([
    $("git rev-parse @").promise(),
    $("git rev-parse --show-toplevel").promise(),
  ]).then((commit_and_basedir) => {
    var commit = commit_and_basedir[0];
    var basedir = commit_and_basedir[1];
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
          "zip -r package.zip index.js node_modules lib app",
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

function performDeployment(FunctionName, force) {
  const Aws = require('aws-sdk');
  const sleep = require('sleep-promise');
  console.log(`Deploying to AWS profile ${Aws.config.credentials.profile}.`);

  var package = jake.Task['package'].value[FunctionName];
  var lambda = new Aws.Lambda({region: 'eu-west-1'});
  lambda.listAliases({FunctionName}).promise().then((result) => {
    return result.Aliases.find((alias) => { return alias.Name == 'active'; });
  }).then((activeAlias) => {
    return lambda.listVersionsByFunction({FunctionName}).promise().then((result) => {
      var activeVersion = result.Versions.find(
          (version) => { return version.Version == activeAlias.FunctionVersion; });
      if (activeVersion.Description == package.commit && !force) {
        throw `Commit ${package.commit} is already deployed.`;
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
      Name: 'active',
      FunctionVersion: result.Version,
    }).promise();
  }).then(() => {
    console.log("Deployment done.");

    if (!process.env.EDITOR) { throw "EDITOR is not set."; }
    if (!process.env.DRI_SLACK_WEBHOOK_URI) { throw "DRI_SLACK_WEBHOOK_URI is not set."; }

    console.log(`Now starting ${process.env.EDITOR} to edit the DRI announcement message…`);
    return Promise.all([
      $("git remote get-url origin").promise(),
      sleep(2000).then(() => {
        return new Promise((resolve, reject) => {
          var tmpFile = Tempy.file();
          jake.exec([`${process.env.EDITOR} ${tmpFile}`], {interactive: true}, () => {
            resolve(fs.readFileSync(tmpFile));
          });
        });
      }),
    ]).then((repoUrl_driMessage) => {
      var repoUrl = repoUrl_driMessage[0];
      var driMessage = repoUrl_driMessage[1];

      slackr = require('slackr');
      slackr.conf.uri = process.env.DRI_SLACK_WEBHOOK_URI;
      if (repoUrl.startsWith("git@github.com:")) {
        repoUrl = `https://github.com/${repoUrl.slice(15)}`;
      }
      var commitUrl = repoUrl;
      if (repoUrl.startsWith("https://github.com")) {
        commitUrl = `${repoUrl}/commit/${package.commit}`;
      }

      var announcement = `:aws: :lambda: (${FunctionName}) ` +
          `<@${process.env.SLACK_USER || process.env.USER}> deployed ` +
          `<${commitUrl}|#${package.commit.substr(0, 8)}>: ${driMessage}`;
      return slackr.string(announcement).then(() => {
        console.log(`Sent DRI announcement: ${announcement}`);
      });
    }).catch((error) => {
      console.log(`Could not notify DRI channel: ${error}`);
      console.log("Don't forget to post an announcement there.");
    });
  }).then(() => {
    complete();
  }).catch((e) => { promiseFail(e); });
}

desc("Deploys the package on AWS.");
task('deploy', ['package'], {async: true}, function(force) {
  for (let definition of deployDefinitions()) {
    performDeployment(definition.functionName, force);
  }
});
