/**
 * Module dependencies.
 */

var path = require('path');
var _ = require('@sailshq/lodash');
var includeAll = require('include-all');
var flaverr = require('flaverr');
var helpRegisterAction = require('./help-register-action');


/**
 * loadActionModules()
 *
 * @param  {[type]}   results [description]
 * @param  {Function} cb      [description]
 * @return {[type]}           [description]
 */
module.exports = function loadActionModules (results, cb) {

  var sails = this;

  // Since this may be called from an async.auto() where it has dependencies,
  // we need to support the `results, cb` signature.  But it also may be
  // called directly, so we need to make sure `results` is optional.
  //
  // TODO: remove this (we should use a wrapping function at wherever this is getting called from async.auto anyway)
  if (_.isFunction(results)) {
    cb = results;
  }

  sails.config.paths = sails.config.paths || {};
  sails.config.paths.controllers = sails.config.paths.controllers || 'api/controllers';

  // Keep track of actions loaded from disk, so we can detect conflicts.
  var actionsLoadedFromDisk = {};

  // Load all files under the controllers folder.
  includeAll.optional({
    dirname: sails.config.paths.controllers,
    filter: /(^[^.]+\.(?:(?!md|txt).)+$)/,
    flatten: true,
    keepDirectoryPath: true
  }, function(err, files) {
    if (err) { return cb(err); }

    try {

      // Set up a var to hold a list of invalid files.
      var garbage = [];
      // Traditional controllers are PascalCased and end with the word "Controller".
      var traditionalRegex = new RegExp('^((?:(?:.*)/)*([0-9A-Z][0-9a-zA-Z_]*))Controller\\..+$');
      // Actions are kebab-cased.
      var actionRegex = new RegExp('^((?:(?:.*)/)*([a-z][a-z0-9-]*))\\..+$');


      // Loop through all of the files returned from include-all.
      _.each(files, function(module) {
        var filePath = module.globalId;
        // If the filepath starts with a dot, ignore it.
        if (filePath[0] === '.') {return;}
        // If the file is in a subdirectory, transform any dots in the subdirectory
        // path into slashes.
        if (path.dirname(filePath) !== '.') {
          filePath = path.dirname(filePath).replace(/\./g, '/') + '/' + path.basename(filePath);
        }
        var identity = '';
        // Attempt to match the file path to the pattern of a traditional controller file.
        var match = traditionalRegex.exec(filePath);
        // Is it a traditional controller?
        if (match) {
          // If it looks like a traditional controller, but it's not a dictionary,
          // throw it in the can.
          if (!_.isObject(module) || _.isArray(module) || _.isFunction(module)) {
            return garbage.push(filePath);
          }
          // Get the controller identity (e.g. /somefolder/somecontroller)
          identity = match[1];
          // Loop through each action in the controller file's dictionary.
          _.each(module, function(action, actionName) {
            // Ignore strings (this could be the "identity" property of a module).
            if (_.isString(action)) {return;}
            // The action identity is the controller identity + the action name,
            // with path separators transformed to dots.
            // e.g. somefolder.somecontroller.dostuff
            var actionIdentity = (identity + '/' + actionName).toLowerCase();
            // If the action identity matches one we've already loaded from disk, bail.
            if (actionsLoadedFromDisk[actionIdentity]) {
              var conflictError = new Error('The action `' + actionName + '` in `' + filePath + '` conflicts with a previously-loaded action.');
              conflictError.code = 'E_CONFLICT';
              conflictError.identity = actionIdentity;
              throw conflictError;
            }

            // Attempt to load the action into our set of actions.
            // Since the following code might throw E_CONFLICT errors, we'll inject a `try` block here
            // to intercept them and wrap the Error.
            try {
              helpRegisterAction(sails, action, actionIdentity, true);
            } catch (e) {
              switch (e.code) {

                case 'E_CONFLICT':
                  // Improve error message with addtl contextual information about where this action came from.
                  // (plus a slightly better stack trace)
                  throw flaverr({
                    code: 'E_CONFLICT', identity: actionIdentity },
                    new Error('Failed to register `' + actionName + '`, an action in the controller loaded from `'+filePath+'` because it conflicts with a previously-registered action.')
                  );

                default:
                  throw e;
              }
            }//</catch>

            // Flag that an action with the given identity was successfully loaded from disk.
            actionsLoadedFromDisk[actionIdentity] = true;

          });
        } // </ is it a traditional controller? >

        // Okay, it's not a traditional controller.  Is it an action?
        // Attempt to match the file path to the pattern of an action file,
        // and make sure it is either a function OR a dictionary containing
        // a function as its `fn` property.
        else if ((match = actionRegex.exec(filePath)) && (_.isFunction(module) || !_.isUndefined(module.machine) || !_.isUndefined(module.friendlyName) || _.isFunction(module.fn))) {
          // The action identity is the same as the module identity
          // e.g. somefolder/dostuff
          var actionIdentity = match[1].toLowerCase();
          if (actionsLoadedFromDisk[actionIdentity]) {
            var conflictError = new Error('The action `' + _.last(actionIdentity.split('/')) + '` in `' + filePath + '` conflicts with a previously-loaded action.');
            conflictError.code = 'E_CONFLICT';
            conflictError.identity = actionIdentity;
            throw conflictError;
          }

          // Attempt to load the action into our set of actions.
          // This may throw an error, which will be caught below.
          try {
            helpRegisterAction(sails, module, actionIdentity, true);
          }
          catch (e) {
            switch (e.code) {

              case 'E_CONFLICT':
                // Improve error message with addtl contextual information about where this action came from.
                throw flaverr({
                  code: 'E_CONFLICT', identity: actionIdentity },
                  new Error('Failed to register `' + actionName + '`, an action loaded from `'+filePath+'` because it conflicts with a previously-registered action.')
                );

              default:
                throw e;
            }
          }//</catch>

          // Flag that an action with the given identity was successfully loaded from disk.
          actionsLoadedFromDisk[actionIdentity] = true;

        } // </ is it an action?>

        // Otherwise give up on this file, it's GARBAGE.
        // No, no, it's probably a very nice file but it's
        // no controller as far as we're concerned.
        else {
          garbage.push(filePath);
        } // </ it is garbage>

      }); // </each(file from includeAll)>


      // Complain about garbage.
      if (garbage.length) {
        sails.log.warn('---------------------------------------------------------------------------');
        sails.log.warn('Files in the `controllers` directory may be traditional controllers or \n' +
                     'action files.  Traditional controllers are dictionaries of actions, with \n' +
                     'pascal-cased filenames ending in "Controller" (e.g. MyGreatController.js).\n' +
                     'Action files are kebab-cased (e.g. do-stuff.js) and contain a single action.\n'+
                     'The following file'+(garbage.length > 1 ? 's were' : ' was')+' ignored for not meeting those criteria:');
        _.each(garbage, function(filePath){sails.log.warn('- '+filePath);});
        sails.log.warn('----------------------------------------------------------------------------\n');
      }

      // (Shallow) merge stuff from sails.config.controllers.moduleDefinitions on top of any loaded files.
      _.each(_.get(sails, 'config.controllers.moduleDefinitions') || {}, function(action, actionIdentity) {

        // This could throw an E_CONFLICT error, so we explicitly intercept it in order to provide a more
        // contextual error message/stack/etc.
        try {
          helpRegisterAction(sails, action, actionIdentity, true);
        } catch (e) {
          switch (e.code) {

            case 'E_CONFLICT':
              // Improve error message with addtl contextual information about where this action came from.
              throw flaverr({
                code: 'E_CONFLICT', identity: actionIdentity },
                new Error('Failed to register `' + actionName + '`, an action loaded from `sails.config.controllers.moduleDefinitions`, because it conflicts with a previously-registered action.')
              );

            default:
              throw e;
          }
        }//</catch>
      });//</each programmatically declared action from `sails.config.controllers.moduleDefinitions`>

      // All done.
      return cb();

    } catch (e) { return cb(e); }
  }); // </includeAll>

};
