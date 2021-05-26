#!/bin/sh
":" //# comment; exec /usr/bin/env node --no-warnings "$0" "$@"
// ^^^ Weird hack to disable warnings - https://gist.github.com/rachidbch/5985f5fc8230b45c4b516ce1c14f0832

var _ = require('lodash');
var alphabet = 'abcdefghijklmnopqrstuvwxyz';
var colors = require('chalk');
var commander = require('commander');
var commanderExtras = require('commander-extras');
var exec = require('@momsfriendlydevco/exec');
var glob = require('globby');
var fs = require('fs');
var readline = require('readline');
var template = require('@momsfriendlydevco/template');

// Utility functions {{{
/**
* Return the newest file date within a glob expression
* This is used to calculate file change deltas
* @param {string} pattern Any valid globby expression
* @returns {Promise<Date>} A promise which will eventually resolve with the newest file date within the glob expression or the date now
*/
var newestFile = pattern => Promise.resolve()
	.then(()=> glob(pattern, {stats: true}))
	.then(files => files.reduce((newest, file) =>
		!newest || file.mtime > newest
			? file.mtime // File is newer
			: newest // Last scoped is still newer
	))
	.then(newest => newest || new Date())


/**
* Ask the user to confirm something via a Readline prompt, throwing if a negative answer
* @param {string} message Question to ask the user, omit the '?' suffix as this is added automatically
* @returns {Promise} A promise which will resolve only if the user answers 'yes'
*/
var cliConfirm = message => new Promise((resolve, reject) => {
	var rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});

	rl.question(`${colors.white(message)} ${colors.blue('[y/N]')}?`, answer => {
		if (/\s*y/i.test(answer)) {
			resolve();
		} else {
			reject();
		}

		rl.close();
	});
});


/**
* Print a step of the deployment process using a bold heading
* @param {*} [msg...] Messages to print
*/
consoleHeading = (...msg) => console.warn(colors.blue.bold('●', ...msg));


/**
* Print a step of the deployment process that was skipped
* @param {*} [msg...] Messages to print
*/
consoleHeadingSkipped = (...msg) => console.warn(colors.grey.bold('✘', ...msg, '(skipped)'));


/**
* Print a step of the deployment process that was confirmed
* @param {*} [msg...] Messages to print
*/
consoleHeadingConfirmed = (...msg) => console.warn(colors.green.bold('✔', ...msg));


/**
* Print a note about the development process
* @param {*} [msg...] Messages to print
*/
consoleNote = (...msg) => console.warn(colors.grey.bold('-', ...msg));

// }}}

// Bootstrap: Load Doop deploy config {{{
try {
	process.env.DOOP_IGNORE_CMD_ARGS = 1; // Tell Doop we're loading it as a sub-process
	// FIXME: add 'node_modules/@doop/deploy/package.json'
	if (glob.sync(['package.json', 'config/index.js']).length != 2) throw `Cannot determine project root directory from CWD: ${process.cwd()}`;
	require(`${process.cwd()}/app/index`);
	if (!app.config.deploy.profiles) throw ('Doop deploy config not found in app.config.deploy.profiles');
} catch (e) {
	console.warn(`Failed to load Doop core / deploy config - ${e.toString()}`);
	process.exit(1);
}
// }}}

// Bootstrap: Load commander CLI config {{{

// Header options
var cli = commander
	.name('deploy')
	.usage('<--all|--PROFILE> [other options]')
	.description('Deploy Doop server profiles')
	.option('--all', 'Deploy all server profiles');

// Profiles
Object.entries(app.config.deploy.profiles)
	.filter(([id, profile]) => profile.enabled ?? true)
	.forEach(([id, profile]) =>
		cli.option(`--${id}`, `Deploy the ${profile.title} server`)
	);

// Footer options
cli = cli
	.option('-f, --force', 'Force full deployments, do not automatically skip stages based on deltas')
	.option('--branch [name]', 'Deploy a specific branch', 'master')
	.option('--no-broadcast', 'Skip broadcast steps (`gulp predeploy` + `gulp postdeploy`)')
	.option('--dry-run', 'Dont actually perform any actions, just say what would run')
	.parse(process.argv)
	.opts()
// }}}

Promise.resolve()
	// Options processing {{{
	.then(()=> {
		if (cli.all) Object.keys(app.config.deploy.profiles)
			.forEach(id => cli[id] = true);

		if (cli.dryRun) // Override regular exec() with safe version if in dry run
			exec = (cmd, options) => {
				consoleNote('--dry-run mode, would exec', '`' + cmd.join(' ') + '`');
				return Promise.resolve();
			};
	})
	// }}}
	// Sanity checks {{{
	.then(()=> {
		if (cli.all) return; // All profiles selected
		if (!Object.keys(app.config.deploy.profiles).some(id => cli[id] === true)) {
			throw `Select at least one profile: --all ${Object.keys(app.config.deploy.profiles).map(id => `--${id}`).join(' ')}`;
		}
	})
	// }}}
	// Doop bootstrap essential {{{
	.then(()=> app.setup())
	.then(()=> app.emit('essencial'))
	// }}}
	// Bootstrap {{{
	.then(()=> {
		// Exec defaults
		exec.defaults.log = true;
		exec.defaults.trim = true;
		exec.defaults.prefixStdout = '->';
		exec.defaults.prefixStderr = colors.red.bold('!>');
	})
	// }}}
	// Calculate peerDeploy {{{
	.then(()=> {
		var enabledPeers = new Set();

		Object.entries(app.config.deploy.profiles)
			.filter(([id, profile]) =>
				(profile.enabled ?? true) // Profile is enabled
				&& cli[id] == true // Is enabled
				&& !_.isEmpty(profile.peerDeploy) // AND has peerDeploy values
			)
			.forEach(([id, profile]) => _.castArray(profile.peerDeploy)
				.forEach(peer => {
					enabledPeers.add(peer);
					cli[peer] = true;
				})
			)

		if (enabledPeers.size > 0) consoleNote('Peer profiles that will also deploy:', Array.from(enabledPeers).sort().join(', '));
	})
	// }}}
	// Deploy selected profiles in series {{{
	.then(()=> Promise.allSeries(
		_(app.config.deploy.profiles)
		.keys()
		.sortBy('sort')
		.map(id => ()=> {
			var deltas = {before: {}, after: {}}; // File stamps before and after `git pull`

			var profile = _.defaultsDeep(app.config.deploy.profiles[id], {
				title: _.startCase(id),
				path: process.cwd(),
				sort: 10,
				processes: 1,
				pm2Name: '${profile.id}-${process.alpha}',
				pm2Names: [],
				pm2Args: {
					default: [
						'-e', profile,
					],
				},
			});

			if (profile.pm2Name && _.isEmpty(profile.pm2Names)) {
				if (profile.processes > 26) throw new Error('Must specify manual pm2Names configuration if processes > 26');
				profile.pm2Names = _.times(profile.processes, offset =>
					template(profile.pm2Name, {
						_,
						profile,
						process: {
							offset,
							alpha: alphabet.substr(offset, 1),
						},
					})
				);
			}

			return Promise.resolve()
				.then(()=> consoleHeading(`Deploy profile "${id}"`))
				// Change to profile path {{{
				.then(()=> process.chdir(profile.path))
				// }}}
				// Calculate BEFORE deltas {{{
				.then(()=> !cli.force && consoleHeading('Calculate pre-deploy deltas'))
				.then(()=> cli.force || Promise.all([
					newestFile(['package.json', 'package-lock.json']).then(newest => deltas.before.packages = newest),
					newestFile('**/*.doop').then(newest => deltas.before.backend = newest),
					newestFile('**/*.vue').then(newest => deltas.before.frontend = newest),
				]))
				// }}}
				// Step: `gulp predeploy` {{{
				.then(()=> cli.broadcast && exec(['gulp', 'preDeploy'])
					.catch(()=> { throw 'Failed `gulp preDeploy`' })
				)
				// }}}
				// Step: Git pull {{{
				.then(()=> exec(['git', 'branch', '--show-current'], {log: false, buffer: true})
					.then(branchName => {
						if (branchName != cli.branch) { // Need to switch branch
							consoleHeading(`Switching to "${cli.branch}" branch`)
							return exec(['git', 'switch', cli.branch])
								.catch(()=> { throw 'Failed `git switch`' })
						}
					})
				)
				.then(()=> consoleHeading('Pulling changes'))
				.then(()=> exec(['git', 'pull', 'origin', cli.branch])
					.catch(()=> { throw 'Failed `git pull`' })
				)
				// }}}
				// Calculate AFTER deltas {{{
				.then(()=> !cli.force && consoleHeading('Calculate post-pull deltas'))
				.then(()=> cli.force || Promise.all([
					newestFile(['package.json', 'package-lock.json']).then(newest => deltas.after.packages = newest),
					newestFile('**/*.doop').then(newest => deltas.after.backend = newest),
					newestFile('**/*.vue').then(newest => deltas.after.frontend = newest),
				]))
				.then(()=> {
					if (cli.force) return;
					consoleHeading('Post-update deltas:');
					console.warn('   *', colors.blue('Packages'), '-', deltas.after.packages > deltas.before.packages ? `has updated, needs ${colors.underline('reinstall')}` : 'no changes');
					console.warn('   *', colors.blue('Backend '), '-', deltas.after.backend > deltas.before.backend ? `has updated, needs ${colors.underline('restart')}` : 'no changes');
					console.warn('   *', colors.blue('Frontend'), '-', deltas.after.frontend > deltas.before.frontend ? `has updated, needs ${colors.underline('rebuild')}` : 'no changes');
					if (
						deltas.after.packages <= deltas.before.packages
						&& deltas.after.backend <= deltas.before.backend
						&& deltas.after.frontend <= deltas.before.frontend
					) consoleNote('Nothing to do here - use --force if this is wrong');
				})
				// }}}
				// Step: NPM install (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force || deltas.after.packages <= deltas.before.packages) return consoleHeadingSkipped('Clean-install NPM packages');
					consoleHeading('Clean-install NPM packages');
					return exec(['npm', 'cleaninstall'])
						.catch(()=> { throw 'Failed `npm ci`' })
				})
				// }}}
				// Step: Frontend build (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force || deltas.after.frontend <= deltas.before.frontend) return consoleHeadingSkipped('Build frontend');
					consoleHeading('Build frontend');
					return exec(['gulp', 'build'])
						.catch(()=> { throw 'Failed `gulp build`' })
				})
				// }}}
				// Step: Backend restart (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force || deltas.after.backend <= deltas.before.backend) return consoleHeadingSkipped('Restart backend processes');
					consoleHeading('Restart backend processes');
					return exec(['gulp', 'build'])
						.catch(()=> { throw 'Failed `gulp build`' })
				})
				// }}}
				// Step: `gulp postdeploy` {{{
				.then(()=> cli.broadcast && exec(['gulp', 'postDeploy'])
					.catch(()=> { throw 'Failed `gulp postDeploy`' })
				)
				// }}}
				.then(()=> consoleHeadingConfirmed(`Profile "${id}" successfully deployed`))
		})
		.value()
	))
	// }}}
	// End {{{
	.then(()=> process.exit(0))
	.catch(e => {
		console.warn(colors.red.bold('DEPLOY ERROR:'), e.toString());
		process.exit(1);
	})
	// }}}
