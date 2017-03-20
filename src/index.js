const caporal = require('caporal');
const jenkins = require('jenkins');
const utils = require('jenkins/lib/utils');
const metadata = require('../package.json');
const Build = require('./build');
const BuildStatus = require('./build-status');
const Queue = require('./queue');
const Request = require('./request');

/**
 * @param {Jenkins} client
 * @param {string} job
 * @param {number} build
 *
 * @returns {Promise.<BuildStatus>}
 */
function displayBuildStatus(client, job, build) {
    return new Promise((resolve, reject) => {
        client.build.get(job, build, (err, data) => {
            if (err) {
                reject(err);
            } else if (data.result !== 'SUCCESS') {
                resolve(new BuildStatus(job, build, 1));
            } else {
                resolve(new BuildStatus(job, build, 0));
            }
        });
    });
}

/**
 * @param {Jenkins} client
 * @param {string} job
 * @param {number} build
 *
 * @returns {Promise.<Build>}
 */
function streamBuildLog(client, job, build) {
    return new Promise((resolve, reject) => {
        const log = client.build.logStream(job, build);

        log.on('data', process.stdout.write.bind(process.stdout));
        log.on('error', (error) => { reject(error); });
        log.on('end', () => { resolve(new Build(job, build)); });
    });
}

/**
 * @param {Jenkins} client
 * @param {string} job
 * @param {number} queue
 * @param {object} logger
 * @param {number} interval
 *
 * @returns {Promise.<Build>}
 */
function waitForBuildToStart(client, job, queue, logger, interval) {
    return new Promise((resolve, reject) => {
        client.queue.item(queue, (err, data) => {
            if (err) {
                reject(err);
            } else if (!data.executable) {
                logger.info(`Build is waiting in queue: ${data.why}`);

                setTimeout(
                    () => {
                        waitForBuildToStart(client, job, queue, logger).then(resolve, reject);
                    },
                    interval * 1000
                );
            } else {
                logger.info(`Starting ${job}#${data.executable.number}`);

                resolve(new Build(job, data.executable.number));
            }
        });
    });
}

/**
 * @param {Jenkins} client
 * @param {string} job
 * @param {object} parameters
 *
 * @returns {Promise.<Queue>}
 */
function triggerBuild(client, job, parameters) {
    return new Promise((resolve, reject) => {
        client.job.build(job, parameters || {}, (err, queue) => {
            if (err) {
                reject(err);
            } else {
                resolve(new Queue(job, queue));
            }
        });
    });
}

/**
 * @param {string} job
 *
 * @returns {Promise.<Request>}
 */
function buildJobRequest(job) {
    const whitelist = [
        /^CI$/,
        /^CI_.*$/,
        /^GITLAB.*$/,
        'GET_SOURCES_ATTEMPTS',
        'ARTIFACT_DOWNLOAD_ATTEMPTS',
        'RESTORE_CACHE_ATTEMPTS',
    ];

    return new Promise((resolve) => {
        const parameters = Object.keys(process.env).reduce((previous, key) => {
            whitelist.forEach((allowed) => {
                if ((allowed.exec && allowed.exec(key)) || allowed === key) {
                    /* eslint-disable no-param-reassign */
                    previous[key] = process.env[key];
                    /* eslint-enable no-param-reassign */
                }
            });

            return previous;
        }, {});

        resolve(new Request(job, parameters));
    });
}

/**
 * @param {Jenkins} client
 * @param {string} job
 * @param {number} build
 *
 * @returns {Promise.<Build>}
 */
function setBuildDescription(client, job, build) {
    return new Promise((resolve) => {
        const req = {
            path: '{folder}/{number}/submitDescription',
            params: {
                /* eslint-disable new-cap */
                folder: utils.FolderPath(job).path(),
                /* eslint-enable new-cap */
                number: build,
            },
            query: {
                description: `
                    Triggered from <a href="${process.env.CI_PROJECT_URL}">${process.env.CI_PROJECT_PATH}</a> in 
                    pipeline #${process.env.CI_PIPELINE_ID} by <a href="mailto:${process.env.GITLAB_USER_EMAIL}">
                    ${process.env.GITLAB_USER_EMAIL}</a>
                `,
            },
        };

        /* eslint-disable no-underscore-dangle */
        client.build.jenkins._post(req, () => { resolve(new Build(job, build)); });
        /* eslint-enable no-underscore-dangle */
    });
}

function parseBool(value) {
    return !!/^1|on?|y(?:es)?|t(?:rue)?$/.exec(value);
}

caporal
    .name(metadata.name)
    .version(metadata.version)
    .description(metadata.description)
    .command('build', 'Build a job on Jenkins')
        .argument('<job>', 'Job name')
        .option('--https', 'Use https to reach Jenkins', caporal.BOOL, parseBool(process.env.JENKLAB_HTTPS))
        .option('--host <host>', 'Jenkins host name', '', process.env.JENKLAB_HOST)
        .option('--port <port>', 'Jenkins port number', caporal.INT, parseInt(process.env.JENKLAB_PORT, 10))
        .option('--username <username>', 'Jenkins username', '', process.env.JENKLAB_USERNAME)
        .option('--token <token>', 'Jenkins token', '', process.env.JENKLAB_TOKEN)
        .option('--polling-interval <token>', 'Polling interval (seconds)', caporal.INT, 5)
        .action((args, options, logger) => {
            const authentication = `${options.username}:${options.token}`;
            const url = `${options.host}${options.port ? `:${options.port}` : ''}`;
            const client = jenkins({
                baseUrl: `http${options.https ? 's' : ''}://${authentication}@${url}`,
                crumbIssuer: true,
            });

            buildJobRequest(args.job)
                .then(request => {
                    logger.debug('Sending request:', request);
                    logger.debug('\n');

                    return request;
                })
                .then(request => triggerBuild(client, request.job, { parameters: request.parameters }))
                .then(queue => waitForBuildToStart(client, queue.job, queue.queue, logger, options.pollingInterval))
                .then(build => setBuildDescription(client, build.job, build.build))
                .then(build => streamBuildLog(client, build.job, build.build))
                .then(build => displayBuildStatus(client, build.job, build.build))
                .then((status) => { process.exit(status.status); })
                .catch((error) => {
                    logger.error(error);
                    logger.error('\n');

                    process.exit(1);
                })
            ;
        })
;

caporal.parse(process.argv);
