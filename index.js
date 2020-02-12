'use strict';

const _ = require('lodash');
const fs = require('fs');
const parseFile = require('node-properties-parser').readSync;

class ServerlessEnvLocal {

  /**
   * Constructor. Object is created by serverless framework.
   *
   * @param serverless context provided by framework
   * @param options command line options provided by framework
   */
  constructor(serverless, options) {
    // Mark this plug-in as only usable with aws
    this.provider = 'aws';

    // Define our hooks. We only care about modifying things when a full deploy is run as
    // only a function deploy will not modify any CF resources
    this.hooks = {
      'after:deploy:deploy': this.afterDeploy.bind(this),
      'after:invoke:local:loadEnvVars': this.beforeLocalInvoke.bind(this),
    };

    // Stash the context away for later
    this.serverless = serverless;
    this.options = options;

    const awsProvider = this.serverless.getProvider('aws');

    // The AWS Region is not set for us yet on the provider
    const region = this.getRegion();

    // Set these on our object for easier injection by unit tests
    this.cloudFormation = new awsProvider.sdk.CloudFormation({ region });
    this.lambda = new awsProvider.sdk.Lambda({ region });
    this.fs = fs;
  }

  /**
   * Called by the serverless framework. Will return a promise of completion
   * @returns {Promise.<TResult>}
   */
  afterDeploy() {
    const stackName = this.getStackName();

    const createFilesPromises = _.map(_.keys(this.serverless.service.functions), (functionName) =>
      this.lambda.getFunctionConfiguration({FunctionName: `${stackName}-${functionName}`})
          .promise().then((functionDetails) => {
        const envVars = _.get(functionDetails, 'Environment.Variables', {});
        return this.createCFFile(functionName, envVars);
      }).catch((err) => {
        this.serverless.cli.log(`[serverless-env-local] Error looking up ENV vars for ${stackName}-${functionName}. Stack must have been deployed before running locally`);
        throw err;
      })
    );
    return Promise.all(createFilesPromises);
  }

  beforeLocalInvoke() {
    const fileName = this.getEnvFileName(this.options.function);
    const path = this.getEnvDirectory();
    const fullPath = `${path}/${fileName}`;
    this.serverless.cli.log(`[serverless-env-local] Pulling in env variables from ${fullPath}`);
    const envVars = this.getCFFileVars(this.options.function);
    _.each(_.toPairs(envVars), envVar => {
      const [key, value] = envVar;
      process.env[key] = value;
    });

  }

  getEnvDirectory() {
    const customDirectory = this.serverless.service.custom && this.serverless.service.custom['resource-output-dir'];
    const directory = customDirectory || '.serverless-env-local';
    const basePath = _.replace(this.serverless.config.servicePath, '/.webpack/service', '');
    return `${basePath}/${directory}`;
  }

  getEnvFileName(functionName) {
    const stage = this.getStage();
    const region = this.getRegion();
    const customName = this.serverless.service.functions[functionName].custom &&
        this.serverless.service.functions[functionName].custom['resource-output-file'];
    // Check if the filename is overridden, otherwise use .<region>_<stage>-<function>
    return customName || `.${region}_${stage}_${functionName}`;
  }

  /**
   * Creates a local file of all the CF resources for this stack in a .properties format
   * @param resources
   * @returns {Promise}
   */
  createCFFile(functionName, resources) {
    // Check if the filename is overridden, otherwise use /<stage>-env
    const path = this.getEnvDirectory();
    const fileName = this.getEnvFileName(functionName);

    if (!this.fs.existsSync(path)) {
      this.fs.mkdirSync(path, 0o700);
    }

    if (!this.fs.statSync(path).isDirectory()) {
      throw new Error(`Expected ${path} to be a directory`);
    }

    // Log so that the user knows where this file is
    this.serverless.cli.log(`[serverless-env-local] Writing ${_.keys(resources).length}` +
        ` CF resources to ${fileName}`);

    const fullFileName = `${path}/${fileName}`;
    // Reduce this to a simple properties file format
    const data = _.reduce(resources, (properties, item, key) =>
        `${properties}${key}=${_.replace(item, /\n/g, "\\n")}\n`, '');
    // Return a promise of this file being written
    return new Promise((resolve, reject) => {
      this.fs.writeFile(fullFileName, data, function(err) {
        if (err) reject(err);
        else resolve(data);
      });
    });
  }

  getCFFileVars(functionName) {
    // Check if the filename is overridden, otherwise use /<stage>-env
    const path = this.getEnvDirectory();
    const fileName = this.getEnvFileName(functionName);
    const fullFileName = `${path}/${fileName}`;
    if (!this.fs.existsSync(fullFileName)) {
      return {};
    }
    return parseFile(fullFileName);
  }

  /**
   * Checks CLI options and settings to discover the current stage that is being worked on
   * @returns {string}
   */
  getStage() {
    let returnValue = 'dev';
    if (this.options && this.options.stage) {
      returnValue = this.options.stage;
    } else if (this.serverless.config.stage) {
      returnValue = this.serverless.config.stage;
    } else if (this.serverless.service.provider.stage) {
      returnValue = this.serverless.service.provider.stage;
    }
    return returnValue;
  }

  /**
   * Checks CLI options and settings to discover the current region that is being worked on
   * @returns {string}
   */
  getRegion() {
    let returnValue = 'us-east-1';
    if (this.options && this.options.region) {
      returnValue = this.options.region;
    } else if (this.serverless.config.region) {
      returnValue = this.serverless.config.region;
    } else if (this.serverless.service.provider.region) {
      returnValue = this.serverless.service.provider.region;
    }
    return returnValue;
  }

  /**
   * Returns the name of the current Stack.
   * @returns {string}
   */
  getStackName() {
    return `${this.serverless.service.service}-${this.getStage()}`;
  }
}

module.exports = ServerlessEnvLocal;
