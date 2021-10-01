var colors = require('chalk');
var glob = require('globby');
var {inspect} = require('util');

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
			newest === 0 || file.stats.mtimeMs > newest
				? file.stats.mtimeMs // File is newer
				: newest // Last scoped is still newer
		, 0))
		.then(newest => newest || Date.now()),


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
		* Add a verbose message
		* @param {*} [msg...] Messages to print
		*/
		verbose: (...msg) =>
			console.warn(colors.grey.grey('-', ...msg.map(m =>
				typeof m == 'string' ? m // Pass simple strings
				: inspect(m, {depth: Infinity, colors: true}) // Throw everything else via inspect
			))),


		/**
		* Print a note about the development process
		* @param {*} [msg...] Messages to print
		*/
		note: (...msg) =>
			console.warn(colors.grey('🛈', ...msg)),
	},


	/**
	* Resolve promises in series
	* This works the same as Promise.all() but resolves its payload, one at a time until all promises are resolved
	* NOTE: Because of the immediately-executing 'feature' of Promises it is recommended that the input array provide
	*       an array of functions which return Promises rather than promises directly - i.e. return promise factories
	*
	* @param {array <Function>} promises An array of promise FACTORIES which will be evaluated in series
	* @returns {Promise} A promise which will resolve/reject based on the completion of the given promise factories being resolved
	* @url https://github.com/MomsFriendlyDevCo/Nodash
	*
	* @example Evaluate a series of promises with a delay, one at a time, in order (note that the map returns a promise factory, otherwise the promise would execute immediately)
	* Promise.allSeries(
	*   [500, 400, 300, 200, 100, 0, 100, 200, 300, 400, 500].map((delay, index) => ()=> new Promise(resolve => {
	*     setTimeout(()=> { console.log('EVAL', index, delay); resolve(); }, delay);
	*   }))
	* )
	*/
	promiseSeries: promises =>
		promises.reduce((chain, promise) =>
			chain.then(()=>
				Promise.resolve(
					typeof promise == 'function' ? promise() : promise
				)
			)
			, Promise.resolve()
		),
};
