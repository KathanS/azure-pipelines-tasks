import * as path from 'path';
import * as tl from 'azure-pipelines-task-lib/task';
import * as URL from 'url';
import * as fs from 'fs';
import * as constants from './constants';
import * as npmregistry from 'azure-pipelines-tasks-packaging-common/npm/npmregistry';
import * as util from 'azure-pipelines-tasks-packaging-common/util';
import * as npmutil from 'azure-pipelines-tasks-packaging-common/npm/npmutil';
import * as os from 'os';
import * as npmrcparser from 'azure-pipelines-tasks-packaging-common/npm/npmrcparser';
import * as pkgLocationUtils from 'azure-pipelines-tasks-packaging-common/locationUtilities';

async function main(): Promise<void> {
    tl.setResourcePath(path.join(__dirname, 'task.json'));
    let saveNpmrcPath: string;
    let npmrc = tl.getInput(constants.NpmAuthenticateTaskInput.WorkingFile);
    let workingDirectory = path.dirname(npmrc);
    let existingEndpoints = tl.getInput('ExistingEndpoints', false);
    let endpointsArray = [];
    if(existingEndpoints){
        endpointsArray = existingEndpoints.split(',');
    }
    if (!(npmrc.endsWith('.npmrc'))) {
        throw new Error(tl.loc('NpmrcNotNpmrc', npmrc));
    }
    else if (!tl.exist(npmrc)) {
        throw new Error(tl.loc('NpmrcDoesNotExist', npmrc));
    }
    else {
        console.log(tl.loc("AuthenticatingThisNpmrc", npmrc));
    }

    if (tl.getVariable("SAVE_NPMRC_PATH")) {
        saveNpmrcPath = tl.getVariable("SAVE_NPMRC_PATH");
    }
    else {
        let tempPath = tl.getVariable('Agent.BuildDirectory') || tl.getVariable('Agent.TempDirectory');
        tempPath = path.join(tempPath, 'npmAuthenticate');
        tl.mkdirP(tempPath);
        saveNpmrcPath = fs.mkdtempSync(tempPath + path.sep);
        tl.setVariable("SAVE_NPMRC_PATH", saveNpmrcPath, false);
        tl.setVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY", tempPath, false);
    }
    let npmrcTable: Object;

    //The index file is a json object that keeps track of where .npmrc files are saved.
    //There is a key-value pairing of filepaths of original npmrc files to IDs.
    //This is important so multiple runs of the npm Authenticate task on the same .npmrc file actually reverts to the original after the build completes.
    let indexFile = path.join(saveNpmrcPath, 'index.json');

    if (fs.existsSync(indexFile)) { //If the file exists, add to it.
        npmrcTable = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

    }
    else { //If the file doesn't exist, create it. 
        npmrcTable = new Object();
        npmrcTable['index'] = 0;
    }

    if (npmrcTable[npmrc] === undefined) {
        npmrcTable[npmrc] = npmrcTable['index'];
        npmrcTable['index']++;
        fs.writeFileSync(indexFile, JSON.stringify(npmrcTable));
        util.saveFileWithName(npmrc, npmrcTable[npmrc], saveNpmrcPath);
    }

    let endpointRegistries: npmregistry.INpmRegistry[] = [];
    let endpointIds = tl.getDelimitedInput(constants.NpmAuthenticateTaskInput.CustomEndpoint, ',');
    if (endpointIds && endpointIds.length > 0) {
        await Promise.all(endpointIds.map(async e => {
            var registry = await npmregistry.NpmRegistry.FromServiceEndpoint(e, true);

            // Add newly discovered endpoints to env variable. Warn of duplicates.
            if(!endpointsArray || endpointsArray.indexOf(registry) == -1){
                endpointsArray.push(registry.url);
                tl.setVariable('ExistingEndpoints', endpointsArray.join(','), false);
            }
            else {
                tl.debug("Auth for the registry '%s' was previously set. Overriding previous configuration");
            }

            endpointRegistries.push(registry);
        }
    ));
    }

    let packagingLocation: pkgLocationUtils.PackagingLocation;
    try {
        packagingLocation = await pkgLocationUtils.getPackagingUris(pkgLocationUtils.ProtocolType.Npm);
    } catch (error) {
        tl.debug('Unable to get packaging URIs');
        util.logError(error);
        throw error;
    }
    let LocalNpmRegistries = await npmutil.getLocalNpmRegistries(workingDirectory, packagingLocation.PackagingUris);

    let npmrcFile = fs.readFileSync(npmrc, 'utf8').split(os.EOL);
    let addedRegistry = [];
    for (let RegistryURLString of npmrcparser.GetRegistries(npmrc, /* saveNormalizedRegistries */ true)) {
        let registryURL = URL.parse(RegistryURLString);
        let registry: npmregistry.NpmRegistry;
        if (endpointRegistries && endpointRegistries.length > 0) {
            for (let serviceEndpoint of endpointRegistries) {
                if (util.toNerfDart(serviceEndpoint.url) == util.toNerfDart(RegistryURLString)) {
                    let serviceURL = URL.parse(serviceEndpoint.url);
                    console.log(tl.loc("AddingEndpointCredentials", registryURL.host));
                    registry = serviceEndpoint;
                    addedRegistry.push(serviceURL);
                    npmrcFile = clearFileOfReferences(npmrc, npmrcFile, serviceURL, addedRegistry);
                    break;
                }
            }
        }
        if (!registry) {
            // Provide system access token auth unless a service endpoint has been provided for that registry
            for (let localRegistry of LocalNpmRegistries) {
                if (util.toNerfDart(localRegistry.url) == util.toNerfDart(RegistryURLString)) {
                    // If a registry is found, but we previously added credentials for it, skip it
                    if (existingEndpoints.indexOf(localRegistry.url) != -1) {
                        if (util.toNerfDart(localRegistry.url) == util.toNerfDart(RegistryURLString)) {
                            let localURL = URL.parse(localRegistry.url);
                            console.log(tl.loc("AddingLocalCredentials"));
                            registry = localRegistry;
                            addedRegistry.push(localURL);
                            npmrcFile = clearFileOfReferences(npmrc, npmrcFile, localURL, addedRegistry);
                            break;
                        }
                    }
                }
            }
        }
        if (registry) {
            tl.debug(tl.loc('AddingAuthRegistry', registry.url));
            npmutil.appendToNpmrc(npmrc, os.EOL + registry.auth + os.EOL);
            tl.debug(tl.loc('SuccessfulAppend'));
            npmrcFile.push(os.EOL + registry.auth + os.EOL);
            tl.debug(tl.loc('SuccessfulPush'));
        }
        else {
            console.log(tl.loc("IgnoringRegistry", registryURL.host));
        }
    }
}

main().catch(error => {
    if (tl.getVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY")) {
        tl.rmRF(tl.getVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY"));
        // Clear the variables after we rm-rf the main root directory
        tl.setVariable("SAVE_NPMRC_PATH", "", false);
        tl.setVariable("NPM_AUTHENTICATE_TEMP_DIRECTORY", "", false);
    } 
    tl.setResult(tl.TaskResult.Failed, error);
});
function clearFileOfReferences(npmrc: string, file: string[], url: URL.Url, addedRegistry: URL.Url[]) {
    let redoneFile = file;
    let warned = false;
    for (let i = 0; i < redoneFile.length; i++) {
        if (file[i].indexOf(url.host) != -1 && file[i].indexOf(url.path) != -1 && file[i].indexOf('registry=') == -1) {
            // Suppress the warning if it is the same registry from .npmrc
            // E.g. registry={url} and @scope:registry={url} in .npmrc, the warning should not appear if both have the same url
            if (!warned && !addedRegistry.includes(url)) {
                tl.warning(tl.loc('CheckedInCredentialsOverriden', url.host));
            }
            warned = true;
            redoneFile[i] = '';
        }
    }
    fs.writeFileSync(npmrc, redoneFile.join(os.EOL));
    return redoneFile;
}
