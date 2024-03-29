#!/usr/bin/env node

var _ = require('lodash');
var alphabet = 'abcdefghijklmnopqrstuvwxyz';
var debug = require('debug')('deploy');
var colors = require('chalk');
var commander = require('commander');
var commanderExtras = require('commander-extras');
var enquirer = require('enquirer');
var exec = require('@momsfriendlydevco/exec');
var glob = require('globby');
var fs = require('node:fs');
var fspath = require('node:path');
var ini = require('ini');
var os = require('node:os');
var semver = require('semver');
var template = require('@momsfriendlydevco/template');
var utils = require('./lib/utils');

// Globals
var cli = commanderExtras();

Promise.resolve()
	// Parse ~/.doop-deploy INI file {{{
	.then(()=> fs.promises.readFile(fspath.join(os.homedir(), '.doop-deploy'), 'UTF-8')
		.then(buf => {
			debug('Reading INI file');
			return ini.parse(buf);
		})
		.then(parsedIni => Object.entries(parsedIni)
			.filter(([key, val]) => { // Ignore dotted paths
				if (/\./.test(key)) {
					debug(`Ignoring dotted notation INI variable "${key}"="${val}"`);
					return false
				} else {
					return true;
				}
			})
			.forEach(([key, val]) => {
				debug(`Set env variable "${key}"=${val}`);
				process.env[key] = val;
			})
		)
		.catch(()=> 0) // Ignore failed file reads - probably doesn't exist
	)
	// }}}
	// Early CLI options processing {{{
	.then(()=> {
		if (cli.unattended)
			cli.forceColor = false;

		if (process.env.DOOP_DEPLOY_BASE) {
			debug(`Switching directory to "${process.env.DOOP_DEPLOY_BASE}"`);
			process.chdir(process.env.DOOP_DEPLOY_BASE);
		}
	})
	// }}}
	// Load Doop deploy config {{{
	.then(()=> {
		process.env.DOOP_IGNORE_CMD_ARGS = 1; // Tell Doop we're loading it as a sub-process
		process.env.DOOP_QUIET = 1; // Tell Doop not to output debugging messages

		// FIXME: add 'node_modules/@doop/deploy/package.json'
		if (glob.sync(['package.json', 'config/index.js']).length != 2) throw `Cannot determine project root directory from CWD: ${process.cwd()}`;
		require(`${process.cwd()}/app/app.backend`);
		if (!global.app) throw ('No global `app` object found');
		if (!app.config.deploy.profiles) throw ('Doop deploy config not found in app.config.deploy.profiles');
	})
	// }}}
	// Commander config / ask for CLI parameters {{{
	.then(()=> {
		// Header options
		cli
			.name('deploy')
			.usage('<--all|--PROFILE> [other options]')
			.description('Deploy Doop servers')
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
			.option('--no-broadcast', 'Skip broadcast steps (`npm run deploy:pre` + `npm run deploy:post`)')
			.option('--no-peers', 'Override setting of peer deployments')
			.option('--no-force-color', 'Do not attempt to force color mode before running')
			.option('-n, --dry-run', 'Dont actually perform any actions, just say what would run')
			.option('--step', 'Step through each command that would be performed asking ahead of each run')
			.option('--unattended', 'Implies: --no-force-color')
			.option('-v, --verbose', 'Be verbose with output - specify multiple times to increase verbosity', (t, v) => v+1, 0)
			.option('--force-packages', 'Force reinstall all packages only')
			.option('--force-frontend', 'Force rebuild frontend only')
			.option('--force-backend', 'Force restart backend only')
			.note('If the `~/.doop-deply` INI file is present it can also specify environment variables in BaSH format')
			.env('DOOP_DEPLOY_BASE', 'If running as a globa NPM, switch to this directory before trying to read config')
			.env('DOOP_DEPLOY_PROFILE', 'If specified, set the profile to deploy from (only works if no profile is selected from the CLI flags)')
			.parse(process.argv)
			.opts()
	})
	// }}}
	// Profile selection {{{
	.then(()=> {
		if (cli.all) Object.keys(app.config.deploy.profiles)
			.forEach(id => cli[id] = true);
	})
	// }}}
	// Post profile options {{{
	.then(()=> {
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
					initial: true,
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
			if (process.env.DOOP_DEPLOY_PROFILE) {
				if (!app.config.deploy.profiles[process.env.DOOP_DEPLOY_PROFILE]) throw new Error(`Invalid ENV profile "${process.env.DOOP_DEPLOY_PROFILE}"`);
				cli.verbose > 1 && utils.log.verbose(`Using profile from ENV "DOOP_DEPLOY_PROFILE"="${process.env.DOOP_DEPLOY_PROFILE}"`);
			} else {
				throw new Error(`Select at least one profile: --all ${Object.keys(app.config.deploy.profiles).map(id => `--${id}`).join(' ')}`);
			}
		}
	})
	// }}}
	// Doop bootstrap essential {{{
	.then(()=> cli.verbose > 0 && utils.log.verbose('Setting up App core'))
	.then(()=> app.setup())
	.then(()=> cli.verbose > 0 && utils.log.verbose('Emitting "essential" to app core'))
	.then(()=> app.emit('essential'))
	// }}}
	// Bootstrap {{{
	.then(()=> {
		if (cli.dryRun) return;

		// Exec defaults
		exec.defaults.log = true;
		exec.defaults.trim = true;
		exec.defaults.prefixStdout = colors.bgWhite.blue('->');
		exec.defaults.prefixStderr = colors.bgRed.white.bold('!>');

		if (cli.forceColors) process.env.FORCE_COLOR = 3;
	})
	// }}}
	// Calculate peerDeploy {{{
	.then(()=> {
		if (!cli.peers) return utils.log.skipped('Peer profiles due to --no-peers');

		if (cli.verbose > 0) utils.log.verbose('Calculating peer deployments')

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
	// Calculate peerDeny {{{
	.then(()=> {
		if (cli.verbose > 0) utils.log.verbose('Calculating peer denies')

		var enabledPeers = new Set(Object.entries(app.config.deploy.profiles)
			.filter(([id, profile]) => profile.enabled)
			.map(([id, profile]) => profile)
		);

		Object.entries(app.config.deploy.profiles)
			.filter(([id, profile]) => profile.enabled && profile.peerDeny)
			.some(([id, profile]) =>
				_.castArray(profile.peerDeny || []).some(peer => {
					if (enabledPeers.has(peer))
						throw `Profile "${id}" cannot be deployed alongside "${peer}" - its peerDeny setting forbids this`;
				})
			)
	})
	// }}}
	// DEPLOY EACH SITE: Deploy selected profiles in series {{{
	.then(()=> utils.promiseSeries(
		_(app.config.deploy.profiles)
		.keys()
		.filter(p => cli.all || cli[p])
		.sortBy('sort')
		.map(id => ()=> {
			var deltas = {before: {}, after: {}}; // File stamps before and after `git pull`
			var cleanEnv = process.env; // Clean environment copy

			// Compute default profile {{{
			var profile = _.defaultsDeep(app.config.deploy.profiles[id], {
				title: _.startCase(id),
				path: process.cwd(),
				repo: 'origin',
				branch: 'master',
				sort: 10,
				processes: 1,
				env: {},
				semver: false,
				semverPackage: true,
				pm2Name: '${id}-${process.alpha}',
				pm2Names: [],
				pm2Args: {
					default: [
						'-e', id,
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
						semver,
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
				.then(()=> cli.verbose > 0 && utils.log.verbose(`chdir "${profile.path}"`))
				.then(()=> process.chdir(profile.path))
				// }}}
				// Merge profile.env {{{
				.then(()=> process.env = {...process.env, ...profile.env})
				// }}}
				// Defer to profile.script if specified {{{
				.then(()=> {
					if (!process.script) return;
					if (cli.verbose > 0) utils.log.verbose(`Defering to deployment script "${process.script}"`)

					return exec(process.script)
						.then(()=> { throw 'SKIP' }) // Stop promise chain and exit
						.catch(()=> { throw new Error(`Error running script \`${process.script}\``) })
				})
				// }}}
				// Calculate BEFORE deltas {{{
				.then(()=> !cli.force && utils.log.heading('Calculate pre-deploy deltas'))
				// TODO: Include CSS files in delta calculation
				.then(()=> cli.force || Promise.all([
					utils.newestFile(['package.json', 'package-lock.json']).then(newest => deltas.before.packages = newest),
					utils.newestFile('**/*.vue').then(newest => deltas.before.frontend = newest),
					utils.newestFile('**/*.doop').then(newest => deltas.before.backend = newest),
				]))
				// }}}
				.then(()=> cli.verbose > 2 && utils.log.verbose('Deployment deltas', deltas))
				// Step: `npm run deploy:pre` {{{
				.then(()=> {
					// Lookup profile path relative to parent project
					var resolvedPath = require.resolve(`${profile.path}/package.json`, {paths: [process.cwd()]});
					var package = require(resolvedPath);
					if (!package?.scripts['deploy:pre']) return; // No pre-deploy script to run
					if (!cli.broadcast) return utils.log.skipped('Running pre-deploy');

					utils.log.heading('Running pre-deploy');
					return cli.broadcast && exec(['npm', 'run', 'deploy:pre'])
						.catch(()=> { throw new Error('Failed `npm run deploy:pre`') })
				})
				// }}}
				// Step: Fetch {{{
				.then(()=> utils.log.heading(`Fetching changes from ${profile.repo}`))
				.then(()=> exec(['git', 'fetch', profile.repo])
					.catch(()=> { throw `Failed \`git fetch ${profile.repo}\`` })
				)
				// }}}
				// Step: Optional branch expression resolution {{{
				.then(()=> {
					if (!profile.branch.startsWith('!')) return; // Use absolute branch name
					var branch = /^\!(?<tag>.+?)\s*(?<args>.+)$/?.groups;
					if (!branch) throw new Error(`Error parsing branch syntax "${profile.branch}", should be of form "TYPE arg1=val1,arg2=val2..."`);
					branch.split(/,/).forEach(arg => {
						var [key, val] = arg.split(/=/, 2);
						branch[key] = val;
					})

					switch (branch.tag) {
						case 'tag':
							branch = {
								semver: '*',
								sort: 'desc',
								...branch,
							};

							utils.log.heading(`Fetching tags from ${profile.repo}`)
							return exec(['git', 'tag', '-l'], {log: false, buffer: true})
								.then(tagBuffer => tagBuffer.split(/\n/))
								.then(tags => tags.sort())
								.then(tags => branch.sort == 'asc' ? tags : tags.reverse())
								.then(tags => tags.find(tag => semver.satisfies(tag, branch.semver)))
								.then(matchingTag => {
									if (!matchingTag) throw new Error(`Unable to satisfy tag semver expression "${branch.semver}"`);
									utils.log.note(`Setting branch to latest tag ${matchingTag}`)
									profile.branch = matchingTag;
								})
								.then(()=> { throw new Error('FIXME: Untested functionality') })
							break;
						default:
							throw new Error(`Unknown special branch type "${profile.branch}"`);
					}
				})
				// }}}
				// Step: Git branch switch {{{
				.then(()=> exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {log: false, buffer: true})
					.then(branchName => {
						if (branchName != profile.branch) { // Need to switch branch
							// Use a different branch to current - switch
							utils.log.heading('Switching branch',  branchName, '=>', profile.branch);
							return exec(['git', 'checkout', '-B', profile.branch, `${profile.repo}/${profile.branch}`])
								.catch(()=> { throw `Failed \`git checkout -B ${cli.branch}\`` })
						} else {
							// Using same branch - force reset to repo state
							utils.log.heading(`Resetting local state to ${profile.repo}/${profile.branch}`);
							return exec(['git', 'checkout', '-B', profile.repo, profile.branch])
								.catch(()=> { throw `Failed \`git checkout -B ${profile.repo} ${cli.branch}\`` })
						}
					})
				)
				// }}}
				// Calculate post deltas {{{
				.then(()=> !cli.force && utils.log.heading('Calculate post deltas'))
				.then(()=> cli.force || Promise.all([
					utils.newestFile(['package.json', 'package-lock.json']).then(newest => deltas.after.packages = newest),
					utils.newestFile('**/*.vue').then(newest => deltas.after.frontend = newest),
					utils.newestFile('**/*.doop').then(newest => deltas.after.backend = newest),
				]))
				.then(()=> {
					if (cli.force) return;
					utils.log.heading('Post-update deltas:');
					utils.log.point(colors.blue('Packages'), '-', deltas.after.packages > deltas.before.packages ? `has updated, needs ${colors.underline('reinstall')}` : cli.forcePackages ? `no changes but forced anyway, will ${colors.underline('reinstall')}` : 'no changes');
					if (cli.verbose > 1) {
						utils.log.verbose(' Pre-deploy=', deltas.before.packages);
						utils.log.verbose('Post-deploy=', deltas.after.packages);
					}
					utils.log.point(colors.blue('Frontend'), '-', deltas.after.frontend > deltas.before.frontend ? `has updated, needs ${colors.underline('rebuild')}` : cli.forceFrontend ? `no changes but forced anyway, will ${colors.underline('rebuild')}` : 'no changes');
					if (cli.verbose > 1) {
						utils.log.verbose(' Pre-deploy=', deltas.before.frontend);
						utils.log.verbose('Post-deploy=', deltas.after.frontend);
					}
					utils.log.point(colors.blue('Backend '), '-', deltas.after.backend > deltas.before.backend ? `has updated, needs ${colors.underline('restart')}` : cli.forceBackend ? `no changes but forced anyway, will ${colors.underline('restart')}` : 'no changes');
					if (cli.verbose > 1) {
						utils.log.verbose(' Pre-deploy=', deltas.before.backend);
						utils.log.verbose('Post-deploy=', deltas.after.backend);
					}
					if (
						deltas.after.packages <= deltas.before.packages
						&& deltas.after.backend <= deltas.before.backend
						&& deltas.after.frontend <= deltas.before.frontend
						&& !cli.forcePackages && !cli.forceFrontend && !cli.forceBackend
					) utils.log.note('Nothing to do here - use `--force` if this is wrong');
				})
				// }}}
				// Step: NPM install (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force && !cli.forcePackages && deltas.after.packages == deltas.before.packages) return utils.log.skipped('Clean-install NPM packages');
					utils.log.heading('Clean-install NPM packages');
					return exec(['npm', 'clean-install', '--loglevel=http'])
						.catch(()=> { throw new Error('Failed `npm clean-install`') })
				})
				// }}}
				// Step: Frontend build (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force && !cli.forceFrontend && deltas.after.frontend == deltas.before.frontend) return utils.log.heading('Build frontend');
					utils.log.heading('Build frontend');
					return exec(['npm', 'run', 'build'])
						.catch(()=> { throw new Error('Failed `npm run build`') })
				})
				// }}}
				// Step: Backend restart (if cli.force || deltas mismatch) {{{
				.then(()=> {
					if (!cli.force && !cli.forceBackend && deltas.after.backend == deltas.before.backend) return utils.log.skipped('Restart backend processes');
					utils.log.heading('Restart backend processes');
					return Promise.resolve()
						.then(()=> exec(['pm2', 'show', profile.pm2Names[0]]) // Query PM2 if the first named process is actually running
							.then(buf => true)
							.catch(e => {
								if (e.toString() == 'Non-zero exit code: 1') return false;
								throw e;
							})
						)
						.then(procExists => {
							if (procExists) {
								utils.log.note('PM2 processes already exists, restarting');
								return exec(['pm2', 'restart', '--wait-ready', '--listen-timeout=10000', ...profile.pm2Names]);
							} else {
								// TODO: Code path for no existing server but also no deltas, so that a missing server can be deployed even when code has not changed (without using `--force` which also runs `npm ci`)
								utils.log.note('PM2 processes do not already exist, starting');
								return utils.promiseSeries(profile.pm2Names.map((pm2Name, offset) => ()=> {
									var args = _.has(profile.pm2Args, pm2Name)
										? profile.pm2Args[pm2Name]
										: profile.pm2Args['default'];
									if (!args) throw new Error(`Cannot find valid PM2 arguments for process "${pm2Name}"`);

									args = args.map(arg => template(arg, {
										_,
										semver,
										profile,
										process: {
											offset,
											alpha: alphabet.substr(offset, 1),
											name: pm2Name,
										},
									}));

									return exec(['pm2', 'start', `--name=${pm2Name}`, '--time', 'server/index.js', '--', ...args], {
										env: _.pickBy(process.env, (v, k) => !k.startsWith('DOOP_')), // Strip all DOOP_ args to sub-process config (otherwise stuff like DOOP_IGNORE_CMD_ARGS and other side-effect stuff gets passed)
									});
								}));
							}
						})
				})
				// }}}
				// Step: `npm run deploy:post` {{{
				.then(()=> {
					// Lookup profile path relative to parent project
					var resolvedPath = require.resolve(`${profile.path}/package.json`, {paths: [process.cwd()]});
					var package = require(resolvedPath);
					if (!package?.scripts['deploy:post']) return; // No pre-deploy script to run
					if (!cli.broadcast) return utils.log.skipped('Running post-deploy');

					utils.log.heading('Running post-deploy');
					return cli.broadcast && exec(['npm', 'run', 'deploy:post'])
						.catch(()=> { throw new Error('Failed `npm run deploy:post`') })
				})
				// }}}
				// Semver + push tag on complete {{{
				.then(()=> {
					if (!profile.semver) return;
					if (
						!cli.force
						&& deltas.after.packages == deltas.before.packages
						&& deltas.after.backend == deltas.before.backend
						&& deltas.after.frontend == deltas.before.frontend
						&& !cli.forcePackages && !cli.forceFrontend && !cli.forceBackend
					) return utils.log.skipped('Skipping Semver version bump - nothing has changed - use `--force` (or `--force-*`) if this is wrong');

					utils.log.heading('Commiting Semver version');
					var version = require('./package.json').version;
					version = {
						current: version,
						major: semver.major(version),
						minor: semver.minor(version),
						patch: semver.patch(version),
					};

					switch (profile.semver) {
						case true:
						case 'patch':
							version.patch++;
							break;
						case 'minor':
							version.minor++;
							break;
						case 'major':
							version.major++;
							break;
						default: throw new Error(`Unknown semver bump profile "${profile.semver}"`);
					}
					version.new = `${version.major}.${version.minor}.${version.patch}`;
					version.tag = `v${version.new}`;

					utils.log.note('Bumping version', version.current, '=>', version.new);

					return Promise.resolve()
						.then(()=> { // Optionally bump package.json version (if profile.semverPackage)
							if (!profile.semverPackage) return;
							return Promise.resolve()
								.then(()=> fs.promises.access('./package.json', fs.constants.R_OK | fs.constants.W_OK)
									.catch(()=> { throw new Error('package.json is not writable to bump semver version') })
								)
								.then(()=> {
									var package = require('./package.json');
									package.version = version.new;
									return fs.promises.writeFile('package.json', JSON.stringify(package.version, null, 2))
								})
								.then(()=> exec(['git', 'add', 'package.json'])
									.catch(()=> { throw `Failed \`git add package.json\`` })
								)
						})
						.then(()=> exec(['git', 'tag', version.tag])
							.catch(()=> { throw `Failed \`git tag ${version.tag}\`` })
						)
						.then(()=> exec(['git', 'push', profile.repo, version.tag])
							.catch(()=> { throw `Failed \`git push ${profile.repo} ${version.tag}\`` })
						)
				})
				// }}}
				// Restore original process.env {{{
				.then(()=> process.env = cleanEnv)
				// }}}
				// End / Catch {{{
				.then(()=> utils.log.confirmed(`Profile "${id}" successfully deployed`))
				.catch(e => {
					if (e === 'SKIP') return; // Ignore normal exit from promise chain
					throw e;
				})
				// }}}
		})
		.value()
	))
	// }}}
	// End {{{
	.then(()=> cli.verbose > 0 && utils.log.verbose('Terminate successfully'))
	.then(()=> process.exit(0))
	.catch(e => {
		console.warn(colors.red.bold('DEPLOY ERROR:'), e.toString());
		if (cli.verbose > 1) utils.log.verbose('Raw error trace:', e);
		debug('Raw error', e);
		process.exit(1);
	})
	// }}}
