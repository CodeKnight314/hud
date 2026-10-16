import { mountSession } from './programs.js';
window.__hudCapture = { ready: false, errors: [] };
try {
  const token = location.pathname.split('/').pop();
  const response = await fetch(`/api/program-previews/${encodeURIComponent(token)}`);
  const session = await response.json();
  if (!response.ok) throw new Error(session.error || 'Preview unavailable');
  const result = await mountSession(document.getElementById('program'), session).ready;
  window.__hudCapture.errors.push(...result.errors);
} catch (error) { window.__hudCapture.errors.push(error.message); }
window.__hudCapture.ready = true;
