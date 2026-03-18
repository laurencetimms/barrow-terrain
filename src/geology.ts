export enum GeologyType {
  Chalk = "chalk",
  Limestone = "limestone",
  Sandstone = "sandstone",
  Granite = "granite",
  Slate = "slate",
  Clay = "clay",
  Glacial = "glacial",
  Water = "water",
}

export interface GeologyInfo {
  type: GeologyType;
  label: string;
  color: string;
  description: string;
}

export const GEOLOGY_INFO: Record<GeologyType, GeologyInfo> = {
  [GeologyType.Chalk]: {
    type: GeologyType.Chalk,
    label: "Chalk",
    color: "#c8d8a8",
    description:
      "Rolling downland, white where the turf has slipped. Springs where the chalk meets clay. Flint in the soil.",
  },
  [GeologyType.Limestone]: {
    type: GeologyType.Limestone,
    label: "Limestone",
    color: "#b0b898",
    description:
      "Grey pavements and green dales. Caves where the water has carved through. Dry valleys and hidden springs.",
  },
  [GeologyType.Sandstone]: {
    type: GeologyType.Sandstone,
    label: "Sandstone",
    color: "#c8a878",
    description:
      "Warm-coloured rock, heathland and pine. Overhangs and shallow caves. The stone takes marks well.",
  },
  [GeologyType.Granite]: {
    type: GeologyType.Granite,
    label: "Granite",
    color: "#8a8a80",
    description:
      "Hard, ancient, resistant. Tors and boulder fields. Thin soil, moorland, bog. Harsh country.",
  },
  [GeologyType.Slate]: {
    type: GeologyType.Slate,
    label: "Slate",
    color: "#708078",
    description:
      "Steep valleys, fast rivers, dense oak in the valley floors. Thin layered rock, dark and wet.",
  },
  [GeologyType.Clay]: {
    type: GeologyType.Clay,
    label: "Clay",
    color: "#5a7848",
    description:
      "Heavy soil, thick forest. Oak and elm, almost impenetrable. The richest farmland, the densest wood.",
  },
  [GeologyType.Glacial]: {
    type: GeologyType.Glacial,
    label: "Glacial debris",
    color: "#9898a0",
    description:
      "Raw ground left by the retreating ice. Moraines, erratics, meltwater channels. No soil. Pioneer birch.",
  },
  [GeologyType.Water]: {
    type: GeologyType.Water,
    label: "Water",
    color: "#4a6878",
    description: "Sea, lake, or the shallow waters of the eastern water-lands.",
  },
};
