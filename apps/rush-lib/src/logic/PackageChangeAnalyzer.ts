// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as path from 'path';
import * as colors from 'colors';

import {
  getPackageDeps,
  IPackageDeps
} from '@microsoft/package-deps-hash';
import { Path } from '@microsoft/node-core-library';

import { RushConstants } from '../logic/RushConstants';
import { RushConfiguration } from '../api/RushConfiguration';
import { Git } from './Git';

export class PackageChangeAnalyzer {
  // Allow this function to be overwritten during unit tests
  public static getPackageDeps: (path: string, ignoredFiles: string[]) => IPackageDeps;

  private _data: Map<string, IPackageDeps>;
  private _rushConfiguration: RushConfiguration;
  private _isGitSupported: boolean;

  public constructor(rushConfiguration: RushConfiguration) {
    this._rushConfiguration = rushConfiguration;
    this._isGitSupported = Git.detectIfGitIsSupported();
    this._data = this._getData();
  }

  public getPackageDepsHash(projectName: string): IPackageDeps | undefined {
    if (!this._data) {
      this._data = this._getData();
    }

    return this._data.get(projectName);
  }

  private _getData(): Map<string, IPackageDeps> {
    // If we are not in a unit test, use the correct resources
    if (!PackageChangeAnalyzer.getPackageDeps) {
      PackageChangeAnalyzer.getPackageDeps = getPackageDeps;
    }

    const projectHashDeps: Map<string, IPackageDeps> = new Map<string, IPackageDeps>();

    // pre-populate the map with the projects from the config
    for (const project of this._rushConfiguration.projects) {
      projectHashDeps.set(project.packageName, {
        files: {}
      });
    }

    const noProjectHashes: { [key: string]: string } = {};

    let repoDeps: IPackageDeps;
    try {
      if (this._isGitSupported) {
        // Load the package deps hash for the whole repository
        repoDeps = PackageChangeAnalyzer.getPackageDeps(
          this._rushConfiguration.rushJsonFolder,
          [RushConstants.packageDepsFilename]
        );
      } else {
        return projectHashDeps;
      }
    } catch (e) {
      // If getPackageDeps fails, don't fail the whole build. Treat this case as if we don't know anything about
      // the state of the files in the repo. This can happen if the environment doesn't have git.
      console.log(colors.yellow(
        `Error calculating the state of the repo. (inner error: ${e}). Continuing without diffing files.`
      ));

      return projectHashDeps;
    }

    // Sort each project folder into its own package deps hash
    Object.keys(repoDeps.files).forEach((filepath: string) => {
      const fileHash: string = repoDeps.files[filepath];

      const projectName: string | undefined = this._getProjectForFile(filepath);

      // If we found a project for the file, go ahead and store this file's hash
      if (projectName) {
        projectHashDeps.get(projectName)!.files[filepath] = fileHash;
      } else {
        noProjectHashes[filepath] = fileHash;
      }
    });

    /* Incremental Build notes:
     *
     * Temporarily revert below code in favor of replacing this solution with something more
     * flexible. Idea is essentially that we should have gulp-core-build (or other build tool)
     * create the package-deps.json. The build tool would default to using the 'simple'
     * algorithm (e.g. only files that are in a project folder are associated with the project), however it would
     * also provide a hook which would allow certain tasks to modify the package-deps-hash before being written.
     * At the end of the build, a we would create a package-deps.json file like so:
     *
     *  {
     *    commandLine: ["--production"],
     *    files: {
     *      "src/index.ts": "478789a7fs8a78989afd8",
     *      "src/fileOne.ts": "a8sfa8979871fdjiojlk",
     *      "common/api/review": "324598afasfdsd",     // this entry was added by the API Extractor task (for example)
     *      "node_modules.json": "3428789dsafdsfaf"    // this is a file which will be created by rush link describing
     *                                                 //   the state of the node_modules folder
     *    }
     *  }
     *
     * Verifying this file should be fairly straightforward, we would simply need to check if:
     *   A) no files were added or deleted from the current folder
     *   B) all file hashes match
     *   C) the node_modules hash/contents match
     *   D) the command line parameters match or are compatible
     *
     *   Notes:
     *   * We need to store the command line arguments, which is currently done by rush instead of GCB
     *   * We need to store the hash/text of the a file which describes the state of the node_modules folder
     *   * The package-deps.json should be a complete list of dependencies, and it should be extremely cheap
     *       to validate/check the file (even if creating it is more computationally costly).
     */

    // Add the "NO_PROJECT" files to every project's dependencies
    // for (const project of PackageChangeAnalyzer.rushConfig.projects) {
    //  Object.keys(noProjectHashes).forEach((filepath: string) => {
    //    const fileHash: string = noProjectHashes[filepath];
    //    projectHashDeps.get(project.packageName).files[filepath] = fileHash;
    //  });
    // }

    // Add the shrinkwrap file to every project's dependencies
    const shrinkwrapFile: string =
      path.relative(this._rushConfiguration.rushJsonFolder,
        this._rushConfiguration.committedShrinkwrapFilename)
        .replace(/\\/g, '/');

    for (const project of this._rushConfiguration.projects) {
      const shrinkwrapHash: string | undefined = noProjectHashes[shrinkwrapFile];
      if (shrinkwrapHash) {
        projectHashDeps.get(project.packageName)!.files[shrinkwrapFile] = shrinkwrapHash;
      }
    }

    return projectHashDeps;
  }

  private _getProjectForFile(filepath: string): string | undefined {
    for (const project of this._rushConfiguration.projects) {
      if (this._fileExistsInFolder(filepath, project.projectRelativeFolder)) {
        return project.packageName;
      }
    }
    return undefined;
  }

  private _fileExistsInFolder(filePath: string, folderPath: string): boolean {
    return Path.isUnder(filePath, folderPath);
  }
}
