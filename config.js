// Public settings for the portal. The anon key is designed to be public: it can only
// do what the database security rules allow (read your own farms, nothing else).
// NEVER put the service_role (secret) key here.
window.RCL_PORTAL = {
  supabaseUrl: "https://wmdhruwkcgtytojlmrkl.supabase.co",
  supabaseAnonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndtZGhydXdrY2d0eXRvamxtcmtsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIwMjU3MjYsImV4cCI6MjEwNzYwMTcyNn0.iRdX-As2inY9J-XyynKxcTDxYospUpgcyz2BOmdM8Ac",
  // Optional: a LINZ Basemaps API key (basemaps.linz.govt.nz) makes the 3D view use LINZ elevation, LiDAR where
  // flown. Without one, 3D uses free terrain tiles (in NZ made from the LINZ 8 m DEM). Browser keys are public.
  linzKey: "",
};
