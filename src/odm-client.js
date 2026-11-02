function endpointUrl(endpoint, path, token = '') {
  const base = (endpoint || '/nodeodm').replace(/\/$/, '');
  const url = `${base}${path}`;
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

async function parseResponse(response) {
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (_) {
    data = { message: text };
  }
  if (!response.ok) {
    throw new Error(data.error || data.message || `NodeODM merespons HTTP ${response.status}`);
  }
  return data;
}

export async function createOdmTask({ endpoint, token, files, name, resolution }) {
  if (!files?.length) throw new Error('Pilih foto drone terlebih dahulu.');
  const form = new FormData();
  for (const file of files) form.append('images', file, file.name);
  form.append('name', name || `Mosaic ${new Date().toISOString().slice(0, 10)}`);
  form.append('options', JSON.stringify([
    { name: 'orthophoto-resolution', value: Number(resolution) || 7.5 },
    { name: 'dtm', value: true },
    { name: 'dsm', value: true },
    { name: 'skip-3dmodel', value: true },
    { name: 'pc-quality', value: 'medium' },
    { name: 'auto-boundary', value: true },
  ]));

  const response = await fetch(endpointUrl(endpoint, '/task/new', token), {
    method: 'POST',
    body: form,
  });
  return parseResponse(response);
}

export async function getOdmTaskInfo({ endpoint, token, uuid }) {
  const response = await fetch(endpointUrl(endpoint, `/task/${encodeURIComponent(uuid)}/info`, token));
  return parseResponse(response);
}

export function odmAssetUrl({ endpoint, token, uuid, asset }) {
  return endpointUrl(endpoint, `/task/${encodeURIComponent(uuid)}/download/${encodeURIComponent(asset)}`, token);
}

export function odmStatus(info) {
  const code = Number(info?.status?.code ?? info?.status ?? 0);
  const names = { 10: 'Queued', 20: 'Running', 30: 'Failed', 40: 'Completed', 50: 'Canceled' };
  return {
    code,
    name: info?.status?.name || names[code] || 'Unknown',
    progress: Math.max(0, Math.min(100, Number(info?.progress ?? (code === 40 ? 100 : 0)))),
    completed: code === 40,
    failed: code === 30 || code === 50,
  };
}
