import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { mountBrand } from "./rebrand";

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "rebrand",
    mount: ({ pluginId, signal }) => mountBrand({ pluginId, signal, document }),
  });
});
