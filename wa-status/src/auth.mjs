// WA-AUTH: שומר את מצב ההתחברות של וואטסאפ בסופאבייס (טבלת wa_auth) דרך הגשר
import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { api } from './api.mjs';

export async function useSupabaseAuthState() {
  const read = async (key) => {
    const { value } = await api('auth_get', { key });
    return value ? JSON.parse(value, BufferJSON.reviver) : null;
  };
  const write = (key, val) => api('auth_set', { items: [{ key, value: JSON.stringify(val, BufferJSON.replacer) }] });
  const del = (key) => api('auth_del', { keys: [key] });

  const creds = (await read('creds')) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await read(`${type}-${id}`);
            if (type === 'app-state-sync-key' && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data) => {
          const items = [];
          const dels = [];
          for (const type in data) for (const id in data[type]) {
            const v = data[type][id];
            if (v) items.push({ key: `${type}-${id}`, value: JSON.stringify(v, BufferJSON.replacer) });
            else dels.push(`${type}-${id}`);
          }
          if (items.length) await api('auth_set', { items });
          if (dels.length) await api('auth_del', { keys: dels });
        },
      },
    },
    saveCreds: () => write('creds', creds),
  };
}
