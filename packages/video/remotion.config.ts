import { Config } from "@remotion/cli/config";

Config.overrideWebpackConfig((config) => ({
  ...config,
  resolve: { ...config.resolve, extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
}));
