const fs = require('fs');
const path = require('path');
const { google } = require('googleapis'); // Will be installed in GitHub Action

async function main() {
  try {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const clientSecret = process.env.GMAIL_CLIENT_SECRET;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Missing required environment variables: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, or GMAIL_REFRESH_TOKEN");
    }

    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      'https://developers.google.com/oauthplayground'
    );

    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const dirPath = path.join(__dirname, '../public/data');
    const filePath = path.join(dirPath, 'feeds.json');
    
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    const rebuild = process.env.REBUILD === 'true';
    const fetchLimit = parseInt(process.env.FETCH_LIMIT || '1000', 10);

    let existingEntries = [];
    const archiveDir = path.join(dirPath, 'archive');

    if (!rebuild && fs.existsSync(archiveDir)) {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      thirtyDaysAgo.setHours(0, 0, 0, 0);
      
      try {
        const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
        files.forEach(file => {
          const dateStr = file.replace('.json', '');
          const fileDate = new Date(dateStr);
          
          if (!isNaN(fileDate.getTime()) && fileDate >= thirtyDaysAgo) {
            const archiveFilePath = path.join(archiveDir, file);
            try {
              const archiveData = JSON.parse(fs.readFileSync(archiveFilePath, 'utf-8'));
              const archEntries = archiveData.entries || [];
              existingEntries.push(...archEntries);
            } catch (err) {
              // Ignore
            }
          }
        });
        console.log(`Loaded ${existingEntries.length} historical entries from daily archives.`);
      } catch (err) {
        console.warn(`Failed to read daily archives: ${err.message}`);
      }
    }
    
    const existingIds = new Set(existingEntries.map(e => e.id));

    console.log(`Fetching Gmail messages (rebuild=${rebuild}, limit=${fetchLimit})...`);
    
    let messages = [];
    let pageToken = undefined;
    
    while (messages.length < fetchLimit) {
      const maxResults = Math.min(fetchLimit - messages.length, 500);
      const res = await gmail.users.messages.list({
        userId: 'mailinglist@sysaifoundation.org',
        maxResults: maxResults,
        pageToken: pageToken
      });
      
      const pageMsgs = res.data.messages || [];
      messages.push(...pageMsgs);
      
      pageToken = res.data.nextPageToken;
      if (!pageToken || pageMsgs.length === 0) break;
    }
    
    console.log(`Found ${messages.length} messages total from Gmail.`);

    const newMessages = messages.filter(msg => !existingIds.has(msg.id));
    console.log(`Found ${newMessages.length} new messages to fetch.`);

    const allEntries = [...existingEntries]; // Start with existing entries

    for (const msgRef of newMessages) {
      const msgRes = await gmail.users.messages.get({
        userId: 'mailinglist@sysaifoundation.org',
        id: msgRef.id,
        format: 'full'
      });
      
      const msgData = msgRes.data;
      const headers = msgData.payload.headers;
      const subject = headers.find(h => h.name.toLowerCase() === 'subject')?.value || '(No Subject)';
      const from = headers.find(h => h.name.toLowerCase() === 'from')?.value || 'Unknown';
      const date = headers.find(h => h.name.toLowerCase() === 'date')?.value || '';
      const msgId = headers.find(h => h.name.toLowerCase() === 'message-id')?.value || msgRef.id;
      const to = headers.find(h => h.name.toLowerCase() === 'to')?.value || '';
      const cc = headers.find(h => h.name.toLowerCase() === 'cc')?.value || '';
      const inReplyTo = headers.find(h => h.name.toLowerCase() === 'in-reply-to')?.value || '';
      const references = headers.find(h => h.name.toLowerCase() === 'references')?.value || '';

      let body = '';
      if (msgData.payload.body && msgData.payload.body.data) {
        body = Buffer.from(msgData.payload.body.data, 'base64').toString('utf-8');
      } else if (msgData.payload.parts) {
        function findTextPart(parts) {
          for (const part of parts) {
            if (part.mimeType === 'text/plain' && part.body && part.body.data) {
              return part.body.data;
            }
            if (part.parts) {
              const found = findTextPart(part.parts);
              if (found) return found;
            }
          }
          return null;
        }
        
        const textData = findTextPart(msgData.payload.parts);
        if (textData) {
          body = Buffer.from(textData, 'base64').toString('utf-8');
        }
      }

      const fromMatch = from.match(/^(.*?)\s*<([^>]+)>/);
      const authorName = fromMatch ? fromMatch[1] : from;
      const authorEmail = fromMatch ? fromMatch[2] : from;

      const listId = headers.find(h => h.name.toLowerCase() === 'list-id')?.value || '';
      let listType = 'Inbox';
      if (listId.includes('linux-f2fs-devel')) {
        listType = 'F2FS';
      } else if (listId.includes('linux-kernel')) {
        listType = 'LKML';
      }

      allEntries.push({
        id: msgRef.id,
        msgId,
        inReplyTo,
        references,
        title: subject,
        updated: date,
        authorName,
        authorEmail,
        content: body,
        listType: listType,
        to: to,
        cc: cc
      });
    }

    // Sort by date
    allEntries.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    
    // Deduplicate entries securely by msgId!
    const seenIds = new Set();
    const deduplicated = allEntries.filter((entry) => {
      if (seenIds.has(entry.msgId)) return false;
      seenIds.add(entry.msgId);
      return true;
    });

    // Filter to keep only entries from the last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const last30DaysEntries = deduplicated.filter(entry => {
      const date = new Date(entry.updated);
      return !isNaN(date.getTime()) && date >= thirtyDaysAgo;
    });

    // Smart Hybrid Approach: Strip content for entries past the latest 2000 to keep file size tiny
    const maxWithContent = 2000;
    const finalEntries = last30DaysEntries.map((entry, index) => {
      if (index >= maxWithContent) {
        const stripped = { ...entry };
        delete stripped.content;
        return stripped;
      }
      return entry;
    });

    console.log(`Total entries in last 30 days: ${last30DaysEntries.length}. Storing ${Math.min(last30DaysEntries.length, maxWithContent)} with full content.`);

    // Save active feed to file
    const outputData = {
      timestamp: new Date().toISOString(),
      entries: finalEntries
    };
    fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2));
    console.log(`Successfully saved ${finalEntries.length} active entries to ${filePath}`);

    // Save all entries to monthly archives to preserve full history
    if (!fs.existsSync(archiveDir)) {
      fs.mkdirSync(archiveDir, { recursive: true });
    }

    // Group all entries by YYYY-MM-DD (daily archives)
    const groupedByDay = {};
    deduplicated.forEach(entry => {
      try {
        const date = new Date(entry.updated);
        if (!isNaN(date.getTime())) {
          const year = date.getUTCFullYear();
          const month = String(date.getUTCMonth() + 1).padStart(2, '0');
          const day = String(date.getUTCDate()).padStart(2, '0');
          const key = `${year}-${month}-${day}`;
          if (!groupedByDay[key]) {
            groupedByDay[key] = [];
          }
          groupedByDay[key].push(entry);
        }
      } catch (e) {
        // Skip invalid dates
      }
    });

    // Write out each day's archive
    let archivedCount = 0;
    Object.entries(groupedByDay).forEach(([dayKey, dayEntries]) => {
      const archiveFilePath = path.join(archiveDir, `${dayKey}.json`);
      let existingArchiveEntries = [];
      
      if (!rebuild && fs.existsSync(archiveFilePath)) {
        try {
          const archiveData = JSON.parse(fs.readFileSync(archiveFilePath, 'utf-8'));
          existingArchiveEntries = archiveData.entries || [];
        } catch (err) {
          // Ignore and start fresh
        }
      }
      
      // Merge, sort, and deduplicate for this specific day
      const mergedDayEntries = [...dayEntries, ...existingArchiveEntries];
      mergedDayEntries.sort((a, b) => new Date(b.updated) - new Date(a.updated));
      
      const seenDayIds = new Set();
      const deduplicatedDay = mergedDayEntries.filter((entry) => {
        if (seenDayIds.has(entry.msgId)) return false;
        seenDayIds.add(entry.msgId);
        return true;
      });
      
      fs.writeFileSync(archiveFilePath, JSON.stringify({
        timestamp: new Date().toISOString(),
        entries: deduplicatedDay
      }, null, 2));
      archivedCount += deduplicatedDay.length;
    });
    console.log(`Successfully updated daily archives. Total archived entries: ${archivedCount}`);

  } catch (error) {
    console.error('Error fetching feeds:', error);
    process.exit(1);
  }
}

main();
