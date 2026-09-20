// Page covers, shared by the note header and the gallery cards.
// A cover is either a gradient name or an image (vault path or URL). Gradients
// need no file and never 404, which makes them the right default offline.
export const GRADIENTS = {
  sunset: 'linear-gradient(120deg, #ff8a4c, #d94f8c 55%, #6b3fa0)',
  dusk: 'linear-gradient(120deg, #2b3a67, #5d4a8a 60%, #b06ab3)',
  mint: 'linear-gradient(120deg, #1d976c, #42d392 70%, #93f9b9)',
  ember: 'linear-gradient(120deg, #3a1c1c, #a8322d 60%, #f0803c)',
  ocean: 'linear-gradient(120deg, #0f2027, #203a43 50%, #2c5364)',
  neon: 'linear-gradient(120deg, #12002f, #7b2ff7 55%, #f107a3)',
  slate: 'linear-gradient(120deg, #232526, #414345)',
  sand: 'linear-gradient(120deg, #3e2f23, #8d6748 60%, #d5b895)',
};

export function coverOf(props) {
  return props.banner || props.cover || props.image || null;
}

// Returns a style object for any element that should show the cover.
export function coverStyle(value, resolveAsset) {
  if (!value) return null;
  if (value.startsWith('gradient:')) {
    return { background: GRADIENTS[value.slice(9)] || GRADIENTS.dusk };
  }
  const url = resolveAsset(value).replace(/["\\]/g, encodeURIComponent);
  return { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center' };
}
