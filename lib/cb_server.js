'use strict';
// ext. libs
var async = require('async');
var EventEmitter2 = require('eventemitter2').EventEmitter2;
// int. libs
var Driver  = require('./lib/driver');
var Reporter = require('./lib/reporter');
var Timer   = require('./lib/timer');
var Config  = require('./lib/config');
var Host    = require('./lib/host');

var defaults = {
  reporter: ['console'],
  driver: ['native'],
  browser: ['phantomjs'],
  viewport: {width: 1280, height: 1024},
  logLevel: 3
};

var cb_server = function (opts) {
  // setup instance
  this._initialize();

  // register exception handler
  this._registerExceptionHandler();

  // normalize options
  this.options = this.normalizeOptions(opts);

  // getting advanced options
  if (opts && opts.advanced) {
    this.advancedOptions = opts.advanced;
  }

  // initiate config
  this.config = new Config(defaults, this.options, this.advancedOptions);

  // override tests if provided on the commandline
  if (this.options.tests) {
    this.config.config.tests = this.options.tests;
  }

  // prepare and load reporter(s)
  this._setupReporters();

  // count all passed & failed assertions
  this.reporterEvents.on('report:assertion', this._onReportAssertion.bind(this));

  // init the timer instance
  this.timer = new Timer();

  // prepare driver event emitter instance
  this._setupDriverEmitter();

  if (!Array.isArray(this.config.get('tests')) && !this.options.remote) {
    this.reporterEvents.emit('error', 'No test files given!');
    this.driverEmitter.emit('killAll');
    process.exit(127);
  }

  // init the driver instance
  this._initDriver();

  if (this.options.remote) {
    var host = new Host({reporterEvents: this.reporterEvents, config: this.config});
    host.run({
      port: !isNaN(parseFloat(this.options.remote)) && isFinite(this.options.remote) ? this.options.remote : false
    });
  }
};


cb_server.prototype = {

  run: function () {
    // early return; in case of remote
    if (this.options.remote) {
      return this;
    }

    // start the timer to measure the execution time
    this.timer.start();

    // emit the runner started event
    this.reporterEvents.emit('report:runner:started');

    // execute all given drivers sequentially
    var drivers = this.driver.getDrivers();
    async.series(drivers, this.testsuitesFinished.bind(this));
    return this;
  },

  testsuitesFinished: function () {
    this.driverEmitter.emit('tests:complete');
    setTimeout(this.reportRunFinished.bind(this), 0);
    return this;
  },

  reportRunFinished: function () {
    this.reporterEvents.emit('report:runner:finished', {
      elapsedTime: this.timer.stop().getElapsedTimeFormatted(),
      assertions: this.assertionsFailed + this.assertionsPassed,
      assertionsFailed: this.assertionsFailed,
      assertionsPassed: this.assertionsPassed,
      status: this.runnerStatus
    });

    //we want to exit process with code 1 to single that test did not pass
    if(this.runnerStatus !== true) {
      var processExitCaptured = false;

      process.on('exit', function() {
        if(processExitCaptured === false) {
          processExitCaptured = true;
          process.exit(1);
        }
      });
    }

    return this;
  },

  normalizeOptions: function (options) {
    Object.keys(options).forEach(function (key) {
      if ({reporter: 1, driver: 1}[key]) {
        options[key] = options[key].map(function (input) { return input.trim(); });
      }
    });

    return options;
  },

  _initialize: function () {
    // prepare error data
    this.warnings = [];
    this.errors = [];

    // prepare state data for the complete test run
    this.runnerStatus = true;
    this.assertionsFailed = 0;
    this.assertionsPassed = 0;

    return this;
  },
  _setupReporters: function () {
    this.reporters = [];
    this.reporterEvents = new EventEmitter2();
    this.reporterEvents.setMaxListeners(Infinity);
    this.options.reporter = this.config.verifyReporters(this.config.get('reporter'), Reporter);
    this.options.reporter.forEach(this._addReporter, this);
    return this;
  },
  _addReporter: function (reporter) {
    this.reporters.push(Reporter.loadReporter(reporter, {events: this.reporterEvents, config: this.config, logLevel: this.config.get('logLevel')}));
    return this;
  },
  _onReportAssertion: function (assertion) {
    if (assertion.success) {
      this.assertionsPassed++;
    } else {
      this.runnerStatus = false;
      this.assertionsFailed++;
    }
    return this;
  },
  _initDriver: function () {
    this.driver = new Driver({
      config: this.config,
      driverEmitter: this.driverEmitter,
      reporterEvents: this.reporterEvents
    });
    this.options.driver = this.config.verifyDrivers(this.config.get('driver'), this.driver);
    return this;
  },
  _setupDriverEmitter: function () {
    var driverEmitter = new EventEmitter2();
    driverEmitter.setMaxListeners(Infinity);
    this.driverEmitter = driverEmitter;
    return this;
  },
  _registerExceptionHandler: function () {
    process.setMaxListeners(Infinity);
    process.on('uncaughtException', this._shutdown.bind(this));
    return this;
  },
  _shutdown: function (exception) {  
    if (exception.message && exception.message.search('This socket has been ended by the other party') !== -1) {
      return false;
    }

    this.driverEmitter.emit('killAll');
    this.reporterEvents.emit('error', exception);
  }

};
module.exports = cb_server;
