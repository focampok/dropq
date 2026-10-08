import type { QlooEntity } from "@/lib/qloo/types";

type Fixture = {
  query: string;
  entityId: string;
  name: string;
  type: string;
};

const FIXTURES: Fixture[] = [
  {
    query: "Ricardo Arjona",
    entityId: "MOCK:artist:ricardo-arjona",
    name: "Ricardo Arjona",
    type: "urn:entity:artist",
  },
  {
    query: "Pollo Campero",
    entityId: "MOCK:brand:pollo-campero",
    name: "Pollo Campero",
    type: "urn:entity:brand",
  },
  {
    query: "Gaby Moreno",
    entityId: "MOCK:artist:gaby-moreno",
    name: "Gaby Moreno",
    type: "urn:entity:artist",
  },
  {
    query: "Bad Bunny",
    entityId: "MOCK:artist:bad-bunny",
    name: "Bad Bunny",
    type: "urn:entity:artist",
  },
  {
    query: "Karol G",
    entityId: "MOCK:artist:karol-g",
    name: "Karol G",
    type: "urn:entity:artist",
  },
  {
    query: "Nike",
    entityId: "MOCK:brand:nike",
    name: "Nike",
    type: "urn:entity:brand",
  },
  {
    query: "Chainsaw Man",
    entityId: "MOCK:tv_show:chainsaw-man",
    name: "Chainsaw Man",
    type: "urn:entity:tv_show",
  },
  {
    query: "Kenshi Yonezu",
    entityId: "MOCK:artist:kenshi-yonezu",
    name: "Kenshi Yonezu",
    type: "urn:entity:artist",
  },
  {
    query: "Uniqlo",
    entityId: "MOCK:brand:uniqlo",
    name: "Uniqlo",
    type: "urn:entity:brand",
  },
];

function toEntity(fixture: Fixture): QlooEntity {
  const raw = {
    entity_id: fixture.entityId,
    name: fixture.name,
    type: fixture.type,
    mock: true,
  };
  return {
    entityId: fixture.entityId,
    name: fixture.name,
    type: fixture.type,
    imageUrl: null,
    raw,
  };
}

export function fixtureSearch(query: string): QlooEntity | null {
  const normalized = query.trim().toLowerCase();
  const match = FIXTURES.find((fixture) => fixture.query.toLowerCase() === normalized);
  return match ? toEntity(match) : null;
}
