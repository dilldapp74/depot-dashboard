// Zugangsdaten des Supabase-Projekts "depot"
// (Supabase-Dashboard → Project Settings → API Keys bzw. oben "Connect").
//
// Hier stehen nur ÖFFENTLICHE Werte – sie sind für den Browser gedacht. Geschützt werden die
// Daten durch die Zugriffsregeln aus supabase/schema.sql. Den "service_role"/"secret"-Schlüssel
// und den privaten VAPID-Schlüssel NIEMALS hier eintragen!
//
// SUPABASE_URL leer lassen = lokale Fassung: Das Dashboard spricht mit server.py auf diesem Rechner.

const SUPABASE_URL = 'https://ulxfxsirinucxxprlwjd.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wgqNXAJTT3I3cVaUWl2ZGA_jrY4cw9M';      // "publishable" bzw. "anon public"

// Öffentlicher Schlüssel für Push-Mitteilungen (VAPID). Leer lassen = keine Push-Mitteilungen.
const VAPID_PUBLIC_KEY = 'BIorsFql5jstcpgUYT3yr1LN1ZSRReqSbxVmLfw3D_j7dHdziYNhwwLuUSRVVlJNo1ul3IElxPcoDbCpXqAFHpI';
