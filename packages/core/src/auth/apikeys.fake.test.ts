import { apiKeyStoreConformance } from "./apikeys.conformance";
import { createFakeApiKeyStore } from "./apikeys.fake";

apiKeyStoreConformance("fake", createFakeApiKeyStore);
