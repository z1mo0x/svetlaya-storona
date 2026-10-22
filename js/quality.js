// Уровень качества 3D под устройство: слабым компьютерам — меньше пикселей, теней и деталей.
// Принудительно: ?q=low|mid|high

export const PROFILES = {
  low: { name: 'low', dpr: 1, shadow: 1024, soft: false, ground: 2048, edges: false, trees: false, fps: 30 },
  mid: { name: 'mid', dpr: 1.5, shadow: 2048, soft: true, ground: 2048, edges: true, trees: true, fps: 60 },
  high: { name: 'high', dpr: 2, shadow: 4096, soft: true, ground: 4096, edges: true, trees: true, fps: 60 },
};
const ORDER = ['low', 'mid', 'high'];

function gpuName() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return name;
  } catch (e) {
    return '';
  }
}

export function detectQuality() {
  const forced = new URLSearchParams(location.search).get('q');
  if (PROFILES[forced]) return { ...PROFILES[forced], forced: true, gpu: gpuName() };

  const gpu = gpuName();
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4; // в Firefox и Safari нет — считаем средним
  const mobile = matchMedia('(pointer: coarse)').matches || innerWidth < 768;
  const software = /swiftshader|llvmpipe|software|basic render|microsoft basic/i.test(gpu);
  const integrated = /intel.*(hd|uhd)|(hd|uhd) graphics|mali|adreno \(tm\) [3-6]\d\d|powervr|vivante/i.test(gpu);
  const discrete = /nvidia|geforce|rtx|gtx|radeon (rx|pro)|apple m\d|apple gpu/i.test(gpu);

  let tier = 'mid';
  if (software || cores <= 2 || mem <= 2 || (integrated && cores <= 4)) tier = 'low';
  else if (discrete && cores >= 6 && mem >= 8 && !mobile) tier = 'high';
  if (mobile && tier === 'high') tier = 'mid';
  return { ...PROFILES[tier], forced: false, gpu };
}

export function lowerTier(profile) {
  const i = ORDER.indexOf(profile.name);
  return i > 0 ? { ...PROFILES[ORDER[i - 1]], forced: false, gpu: profile.gpu } : null;
}
