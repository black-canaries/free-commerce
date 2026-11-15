import {
  outboxConformance,
  repositoryConformance,
} from "@free-commerce/adapter-testkit";
import { createMemoryDatabase } from "./index";

repositoryConformance("memory", createMemoryDatabase);
outboxConformance("memory", createMemoryDatabase);
