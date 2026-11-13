import tile from "@enum-studio/tokens/tile.svg?raw";

export const GET = () =>
  new Response(tile, { headers: { "Content-Type": "image/svg+xml" } });
