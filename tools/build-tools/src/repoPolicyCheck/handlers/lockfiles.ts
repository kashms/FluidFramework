/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import shell from "shelljs";
import {
    Handler,
    readFile
} from "../common";

const filePattern = /^.*?[^_]package-lock\.json$/i; // Ignore _package-lock.json
const urlPattern = /(https?[^"@]+)(\/@.+|\/[^/]+\/-\/.+tgz)/g;
const versionPattern = /"lockfileVersion"\s*:\s*\b1\b/g;

export const handlers: Handler[] = [
    {
        name: "package-lockfiles-no-private-url",
        match: filePattern,
        handler: file => {
            const content = readFile(file);
            const matches = content.match(urlPattern);
            if (matches !== null) {
                const results: string[] = [];
                const containsBadUrl = matches.some((value) => {
                    if (value.startsWith(`https://registry.npmjs.org`)) {
                        return false;
                    }
                    results.push(value)
                    return true;
                });
                if (containsBadUrl) {
                    return `A private registry URL is in lock file: ${file}:\n${results.join("\n")}`;
                }
            }
            return;
        },
    },
    {
        name: "package-lockfiles-npm-version",
        match: filePattern,
        handler: file => {
            const content = readFile(file);
            if (content.match(versionPattern) === null) {
                return `Unexpected 'lockFileVersion' (Please use NPM v6: 'npm i -g npm@latest-6'): ${file}`;
            }
            return;
        },
    }
];
