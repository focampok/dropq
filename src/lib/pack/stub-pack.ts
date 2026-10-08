import { assemblePack, type AssembledPack } from "@/lib/pack/assemble";
import fixture from "@/lib/pack/fixture.json";

export const stubPack: AssembledPack = assemblePack(fixture);
