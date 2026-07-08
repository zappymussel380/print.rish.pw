export const dynamic = "force-static";

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#101820"/>
  <path d="M18 25.5 32 18l14 7.5v15L32 48l-14-7.5z" fill="#5eead4"/>
  <path d="m18 25.5 14 7.5 14-7.5M32 33v15" fill="none" stroke="#101820" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export function GET() {
  return new Response(favicon, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
