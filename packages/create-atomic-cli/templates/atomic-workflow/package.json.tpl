{
  "name": "{{name}}",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": {
    "{{name}}": "./index.ts"
  },
  "dependencies": {
    "@bastani/atomic-sdk": "^0.7.0",
    "{{providerSdkPkg}}": "{{providerSdkVersion}}"
  }
}
