import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { ApiKey, ApiKeyProvider } from "./ApiKey.ts";
import { BoatAuth } from "./AuthProvider.ts";
import { CredentialProfile, CredentialProfileProvider } from "./CredentialProfile.ts";
import * as Credentials from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { NamedSnapshot, NamedSnapshotProvider } from "./NamedSnapshot.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

/**
 * Service tag bundling all Boat providers + auth + credentials. Use
 * `Boat.providers()` to materialize the full layer.
 */
export class Providers extends Provider.ProviderCollection<Providers>()("Boat") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build the complete Boat providers Layer: every Boat resource, the Boat
 * AuthProvider registration (so `alchemy profile edit` can configure it),
 * and credential resolution.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Boat.providers() }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([ApiKey, CredentialProfile, Environment, NamedSnapshot, Webhook]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApiKeyProvider(),
        CredentialProfileProvider(),
        EnvironmentProvider(),
        NamedSnapshotProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(BoatAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
