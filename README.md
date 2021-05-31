@Doop/Deploy
============
All purpose Doop server deployment script.

This project exposes an executable command line script `doop-deploy` which is used to deploy [Doop](https://github.com/MomsFriendlyDevCo/Doop) projects based on their configuration from `app.config.deploy.profiles`.


Configuration
-------------
Configuration is read per-profile from the `app.config.deploy.profiles` object. Each key is the local ID of the profile with the object following the specification below.

| Config key        | Type                 | Default                                  | Description                                                                                                 |
|-------------------|----------------------|------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `id`              | `String`             | (key)                                    | The key of the object, provided here for the template engine                                                |
| `enabled`         | `Boolean`            | `true`                                   | Whether the profile is directly deployable, if disabled the profile can only be deployed via a `peerDeploy` |
| `path`            | `String`             | (current path)                           | Change to this root directory before deploying a profile                                                    |
| `repo`            | `String`             | `-repo=<REPO>` or `"origin"`             | Which source repository to use when deploying, `--repo` overrides the setting if present                    |
| `title`           | `String`             | (key via _.startCase)                    | The human readable name of the deployment profile                                                           |
| `sort`            | `Number`             | `10`                                     | Sort position if deploying multiple profiles (low-to-high)                                                  |
| `peerDeploy`      | `Array` / `String`   | `""`                                     | Additional deployments implied if this profile is deployed                                                  |
| `processes`       | `Number`             | `1`                                      | The number of PM2 processes to manage during a deployment                                                   |
| `env`             | `Object`             | `{}`                                     | Environment variables to set when building (usually `NODE_ENV` needs to be set                              |
| `semver`          | `Boolean` / `String` | `false`                                  | Whether to commit a new version completion, ENUM: 'patch' / `true`, 'minor', 'major'                        |
| `pm2Name`         | `String`             | `"${profile.id}-${process.alpha}"`       | Templatable name of the PM2 processes                                                                       |
| `pm2Names`        | `Array<String>`      | (Computed from pm2Name if not specified) | Computed templatable names or manual overrides if needed                                                    |
| `pm2Args`         | `Object<Array>`      | `{}`                                     | Specific PM2 arguments per computed instance name                                                           |
| `pm2Args.default` | `Array`              | `['-e', (key)]`                          | Universal defaults for PM2 process arguments if no other key matches                                        |


**Notes:**
* Profiles are always deployed according to `sort` order, even if specified by `peerDeploy`
* Setting `semver` requires write access as it will try to commit the new version based on the result of the deployment (cherry-picks and all)


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
