'use strict';
// Modelos de la IA integrada (GGUF para llama-server). El recomendado se elige por la RAM del equipo.
// size y sha256 son los del archivo publicado: la descarga se verifica contra ellos.

// Qwen3.5 (Apache-2.0), cuantizados por Unsloth. URL fijada a un commit: el archivo no cambia bajo nuestros pies.
const HF = (repo, rev, file) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;
const MODELS = [
  {
    id: 'qwen3.5-0.8b', label: 'Qwen 3.5 · 0.8B', tier: 'ligero', minRamGB: 3.5, auto: true,
    file: 'Qwen3.5-0.8B-Q4_K_M.gguf', size: 532517120,
    sha256: 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517',
    url: HF('unsloth/Qwen3.5-0.8B-GGUF', '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0', 'Qwen3.5-0.8B-Q4_K_M.gguf'),
  },
  {
    id: 'qwen3.5-2b', label: 'Qwen 3.5 · 2B', tier: 'recomendado', minRamGB: 7, auto: true,
    file: 'Qwen3.5-2B-Q4_K_M.gguf', size: 1280835840,
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
    url: HF('unsloth/Qwen3.5-2B-GGUF', 'f6d5376be1edb4d416d56da11e5397a961aca8ae', 'Qwen3.5-2B-Q4_K_M.gguf'),
  },
  {
    id: 'qwen3.5-4b', label: 'Qwen 3.5 · 4B', tier: 'preciso', minRamGB: 15, auto: false, // más lento: solo si se elige
    file: 'Qwen3.5-4B-Q4_K_M.gguf', size: 2740937888,
    sha256: '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    url: HF('unsloth/Qwen3.5-4B-GGUF', 'e87f176479d0855a907a41277aca2f8ee7a09523', 'Qwen3.5-4B-Q4_K_M.gguf'),
  },
];

const byId = (id) => MODELS.find(m => m.id === id) || null;
// el más capaz de los automáticos que entra en la RAM; null si ninguno entra
function recommend(totalGB) {
  const fits = MODELS.filter(m => m.auto && totalGB >= m.minRamGB);
  return fits.length ? fits[fits.length - 1] : null;
}

module.exports = { MODELS, byId, recommend };
