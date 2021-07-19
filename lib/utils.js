var colors = require('chalk');
var glob = require('globby');

var utils = module.exports = {
	/**
	* Return the newest file date within a glob expression
	* This is used to calculate file change deltas
	* @param {string} pattern Any valid globby expression
	* @returns {Promise<Date>} A promise which will eventually resolve with the newest file date within the glob expression or the date now
	*/
	newestFile: pattern => Promise.resolve()
		.then(()=> glob(pattern, {stats: true, gitignore: true}))
		.then(files => files.reduce((newest, file) =>
			!newest || file.mtime > newest
				? file.mtime // File is newer
				: newest // Last scoped is still newer
		))
		.then(newest => newest || new Date()),


	/**
	* Various log helpers
	* @type {Object<function>} A collection of utility functions
	*/
	log: {
		/**
		* Print a step of the deployment process using a bold heading
		* @param {*} [msg...] Messages to print
		*/
		heading: (...msg) => console.warn(colors.blue.bold('●', ...msg)),


		/**
		* Print a step of the deployment process that was skipped
		* @param {*} [msg...] Messages to print
		*/
		skipped: (...msg) =>
			console.warn(colors.grey.bold('✘', ...msg, '(skipped)')),


		/**
		* Print a step of the deployment process that was confirmed
		* @param {*} [msg...] Messages to print
		*/
		confirmed: (...msg) =>
			console.warn(colors.green.bold('✔', ...msg)),


		/**
		* Add a bullet list under a heading
		* @param {*} [msg...] Messages to print
		*/
		point: (...msg) =>
			console.warn(colors.bold.blue('   *'), ...msg),


		/**
		* Print a note about the development process
		* @param {*} [msg...] Messages to print
		*/
		note: (...msg) =>
			console.warn(colors.grey('🛈', ...msg)),
	},
};
