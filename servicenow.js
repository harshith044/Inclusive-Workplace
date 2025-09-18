import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();
const BASE_URL = process.env.SN_INSTANCE;
const USER = process.env.SN_USERNAME;
const PASS = process.env.SN_PASSWORD;
const auth = USER && PASS ? { username: USER, password: PASS } : null;

async function post(endpoint, body) {
  const url = `${BASE_URL}/api/x_eyi_wsd_app_form/voiceassistantapi/${endpoint}`;
  try {
    const config = { timeout: 15000 };
    if (auth) config.auth = auth;
    const resp = await axios.post(url, body, config);
    return resp.data?.result || resp.data;
  } catch (err) {
    console.error(`Error calling SN endpoint ${endpoint}:`, err.response?.data || err.message || err);
    throw err;
  }
}

export async function parseIntent(utterance) {
  const data = await post('parse_intent', { utterance });
  return data; // returns { catalog_item_sys_id, user: {sys_id, name, user_name} }
}

export async function getVariables(catalogItemSysId) {
  const data = await post('get_variables', { catalog_item_sys_id: catalogItemSysId });
  let variables = [];
  if (Array.isArray(data?.variables)) variables = data.variables;
  else if (Array.isArray(data)) variables = data;
  else if (Array.isArray(data?.result?.variables)) variables = data.result.variables;

  // Clean up choice fields
  variables = variables.map(v => {
    if (Array.isArray(v.choices)) {
      v.choices = v.choices.map(c => ({ label: c.label || c.value, value: c.value || c.label }));
    }
    return v;
  });

  return { variables };
}

export async function submitCatalog(catalogItemSysId, variables) {
  const data = await post('submit_catalog', { catalog_item_sys_id: catalogItemSysId, variables });
  return data.result || data || {};
}

export async function pollRitm(ritmNumber, onChangeCallback, intervalMs = 5000, attempts = 24) {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await axios.get(`${BASE_URL}/api/x_eyi_wsd_app_form/voiceassistantapi/poll_ritm_state`, {
        params: { ritm_number: ritmNumber },
        auth,
        timeout: 10000,
      });
      const data = resp.data?.result || resp.data;
      const state = data?.state?.toString().toLowerCase();
      const description = data?.description || '';

      if (state && ['complete', 'closed', 'fulfilled'].some(s => state.includes(s))) {
        onChangeCallback({ ritm: ritmNumber, newState: state, description });
        return { ritm: ritmNumber, newState: state, description };
      }
    } catch (e) {
      console.warn('pollRitm call failed', e?.message || e);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

export async function getLoggedInUser() {
  const url = `${BASE_URL}/api/x_eyi_wsd_app_form/voiceassistantapi/get_loggedin_user`;
  try {
    const resp = await axios.get(url, { auth, timeout: 5000 });
    return resp.data?.result || {};
  } catch (err) {
    console.error('Error fetching logged-in user:', err.response?.data || err.message || err);
    return null;
  }
}