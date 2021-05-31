#!/usr/bin/env node

var _ = require('lodash');
var alphabet = 'abcdefghijklmnopqrstuvwxyz';
var colors = require('chalk');
var commander = require('commander');
var commanderExtras = require('commander-extras');
var enquirer = require('enquirer');
var exec = require('@momsfriendlydevco/exec');
var glob = require('globby');
var fs = require('fs');
var semver = require('semver');
var template = require('@momsfriendlydevco/template');
var utils = require('./lib/utils');

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
	.option('--repo [name]', 'Repository to use', 'origin')
	.option('--branch [name]', 'Deploy a specific branch', 'master')
	.option('--no-broadcast', 'Skip broadcast steps (`gulp predeploy` + `gulp postdeploy`)')
	.option('--no-peers', 'Override setting of peer deployments')
	.option('--dry-run', 'Dont actually perform any actions, just say what would run')
	.option('--step', 'Step through each command that would be performed asking ahead of each run')
	.parse(process.argv)
	.opts()
// }}}

Promise.resolve()
	// Options processing {{{
	.then(()=> {
		if (cli.all) Object.keys(app.config.deploy.profiles)
			.forEach(id => cli[id] = true);

		if (cli.dryRun && cli.step) {
			throw new Error('Cannot use --dry-run + --step, choose one or the other');
		} else if (cli.dryRun) { // Override regular exec() with safe version if in dry run
			exec = (cmd, options) => {
				utils.log.note(' --dry-run mode, would exec', '`' + cmd.join(' ') + '`');
				return Promise.resolve();
			};
		} else if (cli.step) { // Override regular exec() with wrapped enquirer() prompt
			var realExec = exec;
			exec = (cmd, options) => {
				var cmdString = _.castArray(cmd).join(' ');
				return enquirer.prompt({
					type: 'confirm',
					name: 'confirm',
					message: `Confirm run> ${cmdString}`,
				})
					.then(({confirm}) => {
						if (confirm) {
							return realExec(cmd, options);
						} else {
							utils.log.skipped('Skip step:', cmdString);
						}
					})
			};
			exec.defaults = realExec.defaults;
		}
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
		if (!cli.peers) return utils.log.skipped('Peer profiles due to --no-peers');

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

		if (enabledPeers.size > 0) utils.log.note('Peer profiles that will also deploy:', Array.from(enabledPeers).sort().join(', '));
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
				repo: 'origin',
				branch: 'master',
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

			// Let various CLI settings override the profile
			if (cli.repo) profile.repo = cli.repo;
			if (cli.branch) profile.branch = cli.branch;
			// }}}

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
				.then(()=> utils.log.heading(`Deploy profile "${id}"`))
				// Change to profile path {{{
				.then(()=> process.chdir(profile.path))
				// }}}
				// Calculate BEFORE deltas {{{
				.then(()=> !cli.force && utils.log.heading('Calculate pre-deploy deltas'))
				.then(()=> cli.force || Promise.all([
					utils.newestFile(['package.json', 'package-lock.json']).then(newest => deltas.before.packages = newest),
					utils.newestFile('**/*.doop').then(newest => deltas.before.backend = newest),
					utils.newestFile('**/*.vue').then(newest => deltas.before.frontend = newest),
				]))
				// }}}
				// Step: `gulp predeploy` {{{
				.then(()=> cli.broadcast && exec(['gulp', 'preDeploy'])
					.catch(()=> { throw 'Failed `gulp preDeploy`' })
				)
				// }}}
				// Step: Fetch {{{
				.then(()=> utils.log.heading(`Fetching changes from ${profile.repo}`))
				.then(()=> exec(['git', 'fetch', profile.repo])
					.catch(()=> { throw `Failed \`git fetch ${profile.repo}\`` })
				)
				// }}}
				// Step: Git branch switch {{{
				.then(()=> exec(['git', 'branch', '--show-current'], {log: false, buffer: true})
					.then(branchName => {
						if (branchName != profile.branch) { // Need to switch branch
							// Use a different branch to current - switch
							utils.log.heading('Switching branch',  branchName, '=>', profile.branch);
							return exec(['git', 'checkout', '-B', profile.branch, `${profile.repo}/${profile.branch}`])
								.catch(()=> { throw `Failed \`git checkout -B ${cli.branch}\`` })
						} else {
							// Using same branch - force reset to repo state
							utils.log.heading(`Resetting local state to ${profile.repo/profile.branch}`);
							return exec(['git', 'checkout', '-B', profile.repo, profile.branch])
								.catch(()=> { throw `Failed \`git checkout -B ${profile.repo} ${cli.branch}\`` })
						}
					})
				)
				// }}}
				// Calculate AFTER deltas {{{
				.then(()=> !cli.force && utils.log.heading('Calculate post-pull deltas'))
				.then(()=> cli.force || Promise.all([
					utils.newestFile(['package.json', 'package-lock.json']).then(newest => deltas.after.packages = newest),
					utils.newestFile('**/*.doop').then(newest => deltas.after.backend = newest),
					utils.newestFile('**/*.vue').then(newest => deltas.after.frontend = newest),
				]))
				.then(()=> {
					if (cli.force) return;
					utils.log.heading('Post-update deltas:');
					utils.log.point(colors.blue('Packages'), '-', deltas.after.packages > deltas.before.packages ? `has updated, needs ${colors.underline('reinstall')}` : 'no changes');
					utils.log.point(colors.blue('Backend '), '-', deltas.after.backend > deltas.before.backend ? `has updated, needs ${colors.underline('restart')}` : 'no changes');
					utils.log.point(colors.blue('Frontend'), '-', deltas.after.frontend > deltas.before.frontend ? `has updated, needs ${colors.underline('rebuild')}` : 'no changes');
					if (
						deltas.after.packages <= deltas.before.packages
						&& deltas.after.backend <= deltas.before.backend
						&& deltas.after.frontend <= deltas.before.frontend
					) utils.log.note('Nothing to do here - use `--force` if this is wrong');
				})
				// }}}
				// Step: NPM install (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force || deltas.after.packages <= deltas.before.packages) return utils.log.skipped('Clean-install NPM packages');
					utils.log.heading('Clean-install NPM packages');
					return exec(['npm', 'cleaninstall'])
						.catch(()=> { throw 'Failed `npm ci`' })
				})
				// }}}
				// Step: Frontend build (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force || deltas.after.frontend <= deltas.before.frontend) return utils.log.heading('Build frontend');
					utils.log.heading('Build frontend');
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
