import { authConformance } from "./auth.conformance";
import { createFakeAuth } from "./auth.fake";

authConformance("fake", () => createFakeAuth());
