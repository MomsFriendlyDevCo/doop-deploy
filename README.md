@Doop/Deploy
============
All purpose Doop server deployment script.

This project exposes an executable command line script `doop-deploy` which is used to deploy [Doop](https://github.com/MomsFriendlyDevCo/Doop) projects based on their configuration from `app.config.deploy.profiles`.

**Features**:

* Simple pull from git + build + restart PM2 deployment process
* Peer deployments of other profiles if required
* Special branch expressions to query + deploy to complex branches
* File date deltas to skip unnecessary package reinstall, build, restart steps
* Automatic handling of PM2 processes and custom names
* Optional branch Semver + version bumping on successful deploy


Configuration
-------------
Configuration is read per-profile from the `app.config.deploy.profiles` object. Each key is the local ID of the profile with the object following the specification below.

| Config key        | Type                 | Default                                  | Description                                                                                                 |
|-------------------|----------------------|------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `id`              | `String`             | (key)                                    | The key of the object, provided here for the template engine                                                |
| `enabled`         | `Boolean`            | `true`                                   | Whether the profile is directly deployable, if disabled the profile can only be deployed via a `peerDeploy` |
| `path`            | `String`             | (current path)                           | Change to this root directory before deploying a profile                                                    |
| `script`          | `Array` / `String`   |                                          | Script or other executable which will be run instead of any of the below processes                          |
| `repo`            | `String`             | `--repo=<REPO>` or `"origin"`            | Which source repository to use when deploying, `--repo` overrides the setting if present                    |
| `branch`          | `String`             | `--branch=<BRANCH>` or `"master"`        | The branch to use when deploying, can be a complex expression - see Branch Expressions                      |
| `title`           | `String`             | (key via _.startCase)                    | The human readable name of the deployment profile                                                           |
| `sort`            | `Number`             | `10`                                     | Sort position if deploying multiple profiles (low-to-high)                                                  |
| `peerDeploy`      | `Array` / `String`   | `""`                                     | Additional deployments implied if this profile is deployed                                                  |
| `peerDeny`        | `Array` / `String`   | `""`                                     | Deployments that are not allowed alongside this profile - an error is raised if both are attempted at once  |
| `processes`       | `Number`             | `1`                                      | The number of PM2 processes to manage during a deployment                                                   |
| `env`             | `Object`             | `{}`                                     | Environment variables to set when building (usually `NODE_ENV` needs to be set                              |
| `semver`          | `Boolean` / `String` | `false`                                  | Whether to commit a new version completion, ENUM: 'patch' / `true`, 'minor', 'major'                        |
| `semverPackage`   | `Boolean`            | `true`                                   | Whether to also bump the new version in `package.json`                                                      |
| `pm2Name`         | `String`             | `"${profile.id}-${process.alpha}"`       | Templatable name of the PM2 processes                                                                       |
| `pm2Names`        | `Array<String>`      | (Computed from pm2Name if not specified) | Computed templatable names or manual overrides if needed                                                    |
| `pm2Args`         | `Object<Array>`      | `{}`                                     | Specific PM2 arguments per computed instance name                                                           |
| `pm2Args.default` | `Array`              | `['-e', (key)]`                          | Universal defaults for PM2 process arguments if no other key matches                                        |


**Notes:**
* Profiles are always deployed according to `sort` order, even if specified by `peerDeploy`
* Setting `semver` requires write access as it will try to commit the new version based on the result of the deployment (cherry-picks and all)
* If `script` is specified it is deferred to instead of any other deploy process - no fetching, building or restarts are performed - only the script is run
* When using `script` only the `path` and `env` settings are processed - all other settings are ignored


Branch expressions
------------------
The `branch` property can be set to either:
* A branch name (e.g. 'master', 'dev')
* A tag (e.g. 'v1.2.3')
* A patch hash (e.g. '36d050e', 'f9748544f569e38646a10e8aeecdd0fa47bba0ac')
* One of the special expressions below

The following branch expressions are also supported, they take the form `TYPE ARG1=VAL1,ARG2=VAL2,ARG3=VAL3` (e.g. `branch: tag semver=v1.x.x,sort=desc`)

| Branch type | Arguments | Default  | Description                                                               |
|-------------|-----------|----------|---------------------------------------------------------------------------|
| `tag`       | `semver`  | `"*"`    | A semver expression to filter tags by, the first valid semver tag is used |
|             | `sort`    | `"desc"` | Whether to sort tags asending, decending before filtering                 |


String Templates
----------------
Some config options can be templated using [ES6 template syntax](https://github.com/MomsFriendlyDevCo/template).

The following variables are available when templating:

| Variable         | Type     | Description                                             |
|------------------|----------|---------------------------------------------------------|
| `_`              | `Object` | Lodash instance                                         |
| `semver`         | `Object` | Semver instance                                         |
| `profile`        | `Object` | Profile configuration object (see above for details)    |
| `process`        | `Object` | Details about the current proceses iteration            |
| `process.offset` | `Number` | Offset (starting at zero) of the current iteration      |
| `process.alpha`  | `String` | Alphabetical offset of the process (e.g. 'a', 'b' etc.) |
| `process.name`   | `String` | Computed process name                                   |


Example config
==============

Project config
--------------
The following is a recommended setup in `package.json`:


```json
{
  "name": "acme-project",
  "version": "1.0.0",
  "description": "Project that does stuff",
  "main": "server/index.js",
  "scripts": {
    "build": "gulp build",
    "dev": "gulp serve",
    "deploy": "doop-deploy",
    "deploy:pre": "gulp preDeploy",
    "deploy:post": "gulp postDeploy",
    "start": "node server"
  }
}
```



Basic config
------------

The following is a standard deployment setup with a "Dev" and "Live" profile located in two different paths.

```javascript
# Within in a Doop `config/index.js` file:
var config = {
	deploy: {
		profiles: {
			dev: {
				title: 'Dev',
				path: '/sites/dev.acme.com',
				sort: 1,
				processes: 2,
				env: {'NODE_ENV': 'dev'},
				pm2Name: 'dev-${process.alpha}',
				pm2Args: {
					default: [
						'-e', 'dev',
						'-o', 'port=${10000 + process.offset + 1}',
						'-o', 'papertrail-program=${process.name}',
					],
					'dev-a': [
						'-e', 'dev',
						'-o', 'port=${10000 + process.offset + 1}',
						'-o', 'papertrail-program=${process.name}',
						'-o', 'cache.cleanAuto=true',
						'-o', 'mongo.migration=true',
					],
				},
			},
			live: {
				title: 'Live',
				path: '/sites/acme.com',
				sort: 2,
				processes: 8,
				env: {'NODE_ENV': 'production'},
				pm2Name: 'live-${process.alpha}',
				pm2Args: {
					default: [
						'-e', 'production',
						'-o', 'port=${10100 + process.offset + 1}',
						'-o', 'papertrail-program=${process.name}',
					],
					'live-a': [
						'-e', 'production',
						'-o', 'port=${10000 + process.offset + 1}',
						'-o', 'papertrail-program=${process.name}',
						'-o', 'cache.cleanAuto=true',
						'-o', 'mongo.migration=true',
					],
				},
			},
		},
	},
}
```


Chain deployments
-----------------
The following is an example where:
* Dev becomes the latest version (on `npm run deploy --dev`)
* Live becomes the Dev version on deploy (on `npm run deploy --live`)
* Fallback is always the previously deployed live version
* Any deployment to Dev is incremented as a patch on semver, if live is deployed it uses the latest semver

The config below should be spliced into the existing config profile:

```javascript
var config = {
	deploy: {
		profiles: {
			dev: {
				semver: 'patch', // Increment semver when deploying Dev
			},
			live: {
				peerDeploy: ['dev', 'fallback'], //  Imply other profiles must be updated first
			},
			fallback: {
				enabled: false, // Disable direct deployment
			},
		},
	},
};
```
