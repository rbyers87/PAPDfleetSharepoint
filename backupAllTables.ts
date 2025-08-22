import { createClient } from "@supabase/supabase-js";
import { parse } from "json2csv";
import fs from "fs";
import archiver from "archiver";
import fetch from "isomorphic-fetch";
import { Client } from "@microsoft/microsoft-graph-client";

// 🔑 Env vars
const SUPABASE_URL = process.env.SUPABASE_URL || "https://YOUR_PROJECT.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_KEY || "YOUR_SERVICE_ROLE_KEY";

const CLIENT_ID = process.env.MS_CLIENT_ID || "";
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET || "";
const TENANT_ID = process.env.MS_TENANT_ID || "";

// 🔑 SharePoint settings
const SHAREPOINT_SITE_ID = process.env.SHAREPOINT_SITE_ID || ""; 
const SHAREPOINT_DOC_LIB = process.env.SHAREPOINT_DOC_LIB || "Documents"; 
const SHAREPOINT_FOLDER = process.env.SHAREPOINT_FOLDER || "FleetBackups"; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// === 1. Get Azure AD access token ===
async function getAccessToken(): Promise<string> {
  const res = await fetch(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  });

  const data = await res.json();
  return data.access_token;
}

// === 2. Upload file to SharePoint Document Library ===
async function uploadToSharePoint(filePath: string, accessToken: string) {
  const fileName = filePath.split("/").pop();
  const fileContent = fs.readFileSync(filePath);

  const client = Client.init({
    authProvider: (done) => done(null, accessToken),
  });

  const uploadPath = `/sites/${SHAREPOINT_SITE_ID}/drives/${SHAREPOINT_DOC_LIB}/root:/${SHAREPOINT_FOLDER}/${fileName}:/content`;

  await client.api(uploadPath).put(fileContent);
  console.log(`☁️ Uploaded to SharePoint: ${SHAREPOINT_FOLDER}/${fileName}`);
}

// === 3. Get all tables ===
async function getAllTables(): Promise<string[]> {
  const { data, error } = await supabase.rpc("get_all_tables");
  if (error) {
    console.error("Error fetching table list:", error.message);
    return [];
  }
  return data || [];
}

// === 4. Main backup workflow ===
async function backupAllTables() {
  console.log("Starting full database backup...");

  const tables = await getAllTables();
  if (tables.length === 0) {
    console.log("No tables found.");
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `db_backup_${timestamp}`;
  fs.mkdirSync(backupDir);

  for (const table of tables) {
    console.log(`Backing up table: ${table}`);
    const { data, error } = await supabase.from(table).select("*");

    if (error) {
      console.error(`❌ Error fetching ${table}:`, error.message);
      continue;
    }

    if (!data || data.length === 0) {
      console.log(`(empty) ${table}`);
      continue;
    }

    const csv = parse(data);
    fs.writeFileSync(`${backupDir}/${table}.csv`, csv);
    console.log(`✅ Saved ${table} (${data.length} rows)`);
  }

  // Zip backup folder
  const zipFile = `${backupDir}.zip`;
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(zipFile);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(backupDir, false);
    archive.finalize();
  });

  console.log(`📦 Backup zipped: ${zipFile}`);

  // Upload to SharePoint
  const token = await getAccessToken();
  await uploadToSharePoint(zipFile, token);

  console.log("🎉 Backup complete.");
}

backupAllTables();
