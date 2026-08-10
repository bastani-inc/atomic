# Handoff: model-runtime registration refresh race

This finding belongs to a later layer. The affected file is `packages/coding-agent/src/core/model-runtime.ts`.

## Race

Registering an extension provider updates the local model snapshot and then starts an offline catalog refresh. A foreground refresh can begin after registration and resolve configured credentials, while the registration-triggered refresh is still waiting for `ModelConfig.load()`. When that older registration refresh resumes, it can publish its catalog after the newer credential-resolved refresh and replace the authoritative API key with the offline result. The result is a model catalog that loses a configured `$ENV` or `!command` credential under load.

The repair is to sequence refreshes and let the registration-triggered offline pass discard its result when a newer refresh has started. The change was implemented in commit `3bf2fdb0f`, then reverted by `6e3c29632` because model-runtime work belongs to an earlier layer. Keep this diagnosis and diff for the layer that owns the model runtime.

## Reverted diff

```diff
diff --git a/packages/coding-agent/src/core/model-runtime.ts b/packages/coding-agent/src/core/model-runtime.ts
index 193491391..2b689cead 100644
--- a/packages/coding-agent/src/core/model-runtime.ts
+++ b/packages/coding-agent/src/core/model-runtime.ts
@@ -89,6 +89,7 @@ export class ModelRuntime implements Models {
     private availabilityErrorSeq = 0;
     private readonly providerAvailabilitySeq = new Map<string, number>();
     private availabilityError: string | undefined;
+    private refreshSequence = 0;
     private constructor(
         credentials: RuntimeCredentials,
         config: ModelConfig,
@@ -524,7 +525,28 @@ export class ModelRuntime implements Models {
     }
     async refresh(options: ModelsRefreshOptions = {}): Promise<ModelsRefreshResult> {
-        this.config = await ModelConfig.load(this.modelsPath);
+        return this.runRefresh(options, ++this.refreshSequence);
+    }
+
+    /**
+     * A registration's offline catalog pass must not publish after a newer refresh
+     * that resolves configured credentials.
+     */
+    private scheduleRegistrationRefresh(): void {
+        const sequence = ++this.refreshSequence;
+        void this.runRefresh({ allowNetwork: false }, sequence, true);
+    }
+
+    private async runRefresh(
+        options: ModelsRefreshOptions,
+        sequence: number,
+        discardIfSuperseded = false,
+    ): Promise<ModelsRefreshResult> {
+        const config = await ModelConfig.load(this.modelsPath);
+        if (discardIfSuperseded && sequence !== this.refreshSequence) {
+            return { aborted: true, errors: new Map<string, Error>() };
+        }
+        this.config = config;
         this.configureRadiusProviders();
         if (options.providers) {
             for (const providerId of new Set(options.providers)) this.recomposeProvider(providerId);
@@ -561,7 +583,7 @@ export class ModelRuntime implements Models {
     this.nativeExtensionProviders.set(provider.id, provider);
     this.recomposeProvider(provider.id);
     this.updateModelSnapshot();
-    void this.refresh({ allowNetwork: false });
+    this.scheduleRegistrationRefresh();
     }
     registerProvider(providerId: string, config: ProviderConfigInput): void {
@@ -606,7 +628,7 @@ export class ModelRuntime implements Models {
             }
             this.snapshot = { ...this.snapshot, auth, configuredProviders, available };
         }
-    void this.refresh({ allowNetwork: false });
+    this.scheduleRegistrationRefresh();
     }
     unregisterProvider(providerId: string): void {
@@ -614,6 +636,6 @@ export class ModelRuntime implements Models {
     this.nativeExtensionProviders.delete(providerId);
     this.recomposeProvider(providerId);
     this.updateModelSnapshot();
-    void this.refresh({ allowNetwork: false });
+    this.scheduleRegistrationRefresh();
     }
 }
```
