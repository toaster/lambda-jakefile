const $ = require('procstreams');

desc('Creates a package for upload to AWS.');
task('package', {async: true}, function () {
  const Tempy = require('tempy');
  const Path = require('path');

  return Promise.all([
    new Promise((resolve, reject) => {
      $("git rev-parse HEAD").data((err, stdout, stderr) => {
        if (err) { throw err; }
        resolve(stdout.toString().trim());
      });
    }),
    new Promise((resolve, reject) => {
      $("git rev-parse --show-toplevel").data((err, stdout, stderr) => {
        if (err) { throw err; }
        resolve(stdout.toString().trim());
      });
    }),
  ]).then((commit_and_basedir) => {
    var commit = commit_and_basedir[0];
    var basedir = commit_and_basedir[1];
    var packageFileName = `package_${Path.basename(basedir)}_${commit}.zip`;

    return new Promise((resolve, reject) => {
      const fs = require('fs');

      if (fs.existsSync(packageFileName)) {
        resolve();
      } else {
        process.chdir(Tempy.directory());
        jake.exec([
          `rsync -a ${basedir}/.git .`,
          `git reset --hard ${commit}`,
          "npm install --production",
          "zip -r package.zip index.js node_modules",
          `cp package.zip ${basedir}/${packageFileName}`,
        ], {printStdout: true, printStderr: true}, () => {
          console.log(`Package created in ${packageFileName}`);
          resolve();
        });
      }
    }).then(() => {
      complete({commit: commit, path: `${basedir}/${packageFileName}`});
    });
  });
});

desc("Deploys the package on AWS.");
task('deploy', ['package'], {async: true}, function(FunctionName) {
  if (!FunctionName) { fail("You have to specify a function name to deploy to."); }

  const Aws = require('aws-sdk');
  const fs = require('fs');
  console.log(`Deploying to AWS profile ${Aws.config.credentials.profile}.`);

  var package = jake.Task['package'].value;
  var lambda = new Aws.Lambda({region: 'eu-west-1'});
  lambda.listAliases({FunctionName}).promise().then((result) => {
    return result.Aliases.find((alias) => { return alias.Name == 'active'; });
  }).then((activeAlias) => {
    return lambda.listVersionsByFunction({FunctionName}).promise().then((result) => {
      var activeVersion = result.Versions.find(
          (version) => { return version.Version == activeAlias.FunctionVersion; });
      if (activeVersion.Description == package.commit) {
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
    return new Promise((resolve, reject) => {
      if (!process.env.DRI_SLACK_WEBHOOK_URI) {
        reject("DRI_SLACK_WEBHOOK_URI is not set.");
      }
      $("git remote get-url origin").data((err, stdout, stderr) => {
        if (err) { throw err; }
        resolve(stdout.toString().trim());
      });
    }).then((repoUrl) => {
      slackr = require('slackr');
      slackr.conf.uri = process.env.DRI_SLACK_WEBHOOK_URI;
      if (repoUrl.startsWith("git@github.com:")) {
        repoUrl = `https://github.com/${repoUrl.slice(15)}`;
      }
      var commitUrl = repoUrl;
      if (repoUrl.startsWith("https://github.com")) {
        commitUrl = `${repoUrl}/commit/${package.commit}`;
      }

      return new Promise((resolve, reject) => {
        $("git show --pretty=format:%s --no-patch").data((err, stdout, stderr) => {
          if (err) { throw err; }
          resolve(stdout.toString().trim());
        });
      }).then((commitMsg) => {
        var announcement = `:aws: :lambda: (${FunctionName}) ` +
            `@${process.env.SLACK_USER || process.env.USER} deployed ` +
            `“<${commitUrl}|${commitMsg.replace(">", "&gt;")}>”.`;
        return slackr.string(announcement).then(() => {
          console.log(`Sent DRI announcement: ${announcement}`);
        });
      })
    }).catch((error) => {
      console.log(`Could not notify DRI channel: ${error}`);
      console.log("Don't forget to post an announcement there.");
    });
  }).catch((e) => {
    console.log(`Didn't deploy: ${e}`);
  }).then(() => { complete(); });
});
