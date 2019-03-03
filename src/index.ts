
import * as path from 'path';
import { Configuration } from 'webpack';
import CopyPlugin from 'copy-webpack-plugin';
import DuplicatePackageCheckerPlugin from 'duplicate-package-checker-webpack-plugin';
import GlobEntriesPlugin  from 'webpack-watched-glob-entries-plugin';
import ZipPlugin from 'zip-webpack-plugin';

/**
 * Moves all instances of ZipPlugin to the end of the plugins list so that they
 * will zip all assets instead of just those created by the plugins before them.
 *
 * @param config Webpack config to update.
 */
export function fixZipPackage(config: Configuration) {
    if (!config.plugins) {
        return;
    }

    // When we are installed via npm link, webextension-toolbox has a different
    // copy of zip-webpack-plugin than we do, so match on class name too.
    const isZipPlugin = (x: any) => (x instanceof ZipPlugin || x.constructor.name == 'ZipPlugin');

    // Move any ZipPlugin to the end.
    config.plugins = config.plugins.sort((a, b) => {
        const aIsZip = isZipPlugin(a) ? 1 : 0;
        const bIsZip = isZipPlugin(b) ? 1 : 0;

        return aIsZip - bIsZip;
    });
}

export function getDedupeAliases(modules: string[], folder: string = './node_modules') {
    let alias: Record<string, string> = {};

    for (const mod of modules) {
        alias[mod] = path.resolve(path.join(folder, mod));
    }

    return alias;
}

/**
 * Prevents duplicates of the given modules in bundles when the project and/or
 * npm link'ed modules have the same dependencies. All instances of the given
 * modules will resolve to the version in `folder` (which defaults to the
 * project's node_modules folder).
 *
 * @param config Webpack config to update.
 * @param modules List of module names to deduplicate.
 * @param base Directory where versions of modules to use live.
 */
export function dedupeModules(config: Configuration, modules: string[], folder: string = './node_modules') {
    // https://medium.com/@penx/managing-dependencies-in-a-node-package-so-that-they-are-compatible-with-npm-link-61befa5aaca7
    config.resolve = config.resolve || {};

    config.resolve.alias = {
        ...config.resolve.alias,
        ...getDedupeAliases(modules, folder),
    }

    // Make sure the deduped modules are compatible versions.
    // Otherwise deduping could break things.
    config.plugins = config.plugins || [];

    if (!config.plugins.some(p => p instanceof DuplicatePackageCheckerPlugin)) {
        config.plugins.push(new DuplicatePackageCheckerPlugin());
    }
}

/**
 * Selects a source map style that works well with the Chrome debugger.
 *
 * @param config Webpack config to update.
 * @param dev Is this a development build?
 */
export function useSourceMap(config: Configuration, dev: boolean) {
    if (dev) {
        config.devtool = 'cheap-module-source-map';

        config.module = config.module || { rules: [] };
        config.module.rules.push({
            test: /\.js$/,
            use: ['source-map-loader'],
            enforce: 'pre',
        });

    } else {
        config.devtool = 'source-map';
    }
}

export interface TypeScriptOptions {
    /** Paths to search for entry points. Default: config.context and all its children. */
    entryPaths?: string[];

    /** Folders to search for modules. Default: node_modules */
    modules?: string[];

    /** TypeScript config file. Defualt: tsconfig.json */
    tsConfigFile?: string;
}

/**
 * Adds support for compiling TypeScript files.
 *
 * @param config Webpack config to update.
 * @param options TypeScript compilation options.
 */
export function useTypescript(config: Configuration, options?: TypeScriptOptions) {
    const options_ = {
        entryPaths: [
            path.resolve(config.context || 'app', '**')
        ],
        modules: ['./node_modules'],
        tsConfigFile: 'tsconfig.json',
        ...options,
    }

    // Add support for .ts(x) entry points.
    config.resolve = config.resolve || {};
    config.resolve.extensions = config.resolve.extensions || [];
    config.resolve.modules = config.resolve.modules || [];

    config.resolve.extensions.push('.ts');
    config.resolve.extensions.push('.tsx');
    config.resolve.modules = [...config.resolve.modules, ...options_.modules];

    // This overwrites webextension-toolbox's entry, so we need to handle
    // regular JavaScript files too.
    const ENTRY_FILES = '*.{js,mjs,jsx,ts,tsx}'
    config.entry = GlobEntriesPlugin.getEntries(
        options_.entryPaths.map(p => path.resolve(p, ENTRY_FILES))
    );

    // Add loaders to typescript and tslint
    config.module = config.module || { rules: [] };

    config.module.rules.push({
        test: /\.(ts|tsx)$/,
        enforce: 'pre',
        use: [{
            loader: 'tslint-loader',
            options: {
                tsConfigFile: options_.tsConfigFile,
                emitErrors: true,
            },
        }]
    });

    config.module.rules.push({
        test: /\.(ts|tsx)$/,
        use: [{
            loader: 'ts-loader',
        }],
    });
}

interface CssOptions {
    /** Reduce image sizes? Default: true */
    optimizeImages?: boolean;
    /** Path to store images in build directory. Default = images */
    imagePath?: string;
}

/**
 * Adds support for bundling CSS style sheets and any images referenced by them.
 *
 * @param config Webpack config to update.
 * @param options CSS bundling options.
 */
export function useCss(config: Configuration, options?: CssOptions) {
    const options_ = {
        optimizeImages: true,
        imagePath: 'images',
        ...options,
    };

    // Add css support
    config.module = config.module || { rules: [] };

    config.module.rules.push({
        test: /\.css$/,
        use: [
            { loader: 'style-loader' },
            { loader: 'css-loader' },
        ],
    });

    // Add image support
    config.module.rules.push({
        test: /\.(bmp|gif|jpg|jpeg|png|svg|tif|tiff|webp)$/,
        use: [{
            loader: 'file-loader',
            options: {
                outputPath: `${options_.imagePath}/`,
                publicPath: `/${options_.imagePath}/`,
            },
        }, {
            loader: 'image-webpack-loader',
            options: {
                disable: !options_.optimizeImages,
            }
        }],
    });
}

export interface ExternalDefinition {
    /** Name of the module. */
    module: string;
    /** Global variable to avoid bundling. */
    global: string;
    /** Script to copy. If omitted, no script is copied. */
    from?: string;
    /** Destination for copied script. */
    to?: string;
}

/**
 * Use an external library, copying it directly to the output directory instead
 * of bundling it.
 *
 * As of webextension-toolbox version 3.0.0, you must call `fixZipPackage()`
 * after any calls to `useExternal()` or the external library will not be
 * included in any packages built using `webextension-toolbox build`.
 *
 * @param config Webpack config to update.
 * @param def Definition for the external module.
 */
export function useExternal(config: Configuration, def: ExternalDefinition) {
    const external = {
        [def.module]: def.global
    };

    if (config.externals) {
        if (Array.isArray(config.externals)) {
            config.externals.push(external);
        } else {
            config.externals = [config.externals, external];
        }
    } else {
        config.externals = external;
    }

    config.plugins = config.plugins || [];

    if (def.from && def.to) {
        config.plugins.push(new CopyPlugin([
            {
                from: def.from,
                to: def.to,
                cache: true
            },
        ]));
    }
}