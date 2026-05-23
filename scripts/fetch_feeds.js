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

    let existingEntries = [];
    if (fs.existsSync(filePath)) {
      try {
        const fileData = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        existingEntries = fileData.entries || [];
        console.log(`Loaded ${existingEntries.length} existing entries from ${filePath}`);
      } catch (err) {
        console.warn(`Failed to parse existing feeds.json: ${err.message}. Starting fresh.`);
      }
    }
    
    const existingIds = new Set(existingEntries.map(e => e.id));

    console.log(`Fetching Gmail messages...`);
    
    const res = await gmail.users.messages.list({
      userId: 'mailinglist@sysaifoundation.org',
      maxResults: 1000
    });

    const messages = res.data.messages || [];
    console.log(`Found ${messages.length} messages.`);

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
      if (listId.includes('linux-kernel')) {
        listType = 'LKML';
      } else if (listId.includes('linux-f2fs-devel')) {
        listType = 'F2FS';
      }

      allEntries.push({
        id: msgRef.id,
        msgId,
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

    // Limit total entries to keep file size reasonable and within GitHub limits (and optimize browser load times)
    const maxEntries = 2000;
    const finalEntries = deduplicated.slice(0, maxEntries);
    console.log(`Total entries after merge: ${deduplicated.length}. Keeping the latest ${finalEntries.length} entries.`);

    // Save to file
    const outputData = {
      timestamp: new Date().toISOString(),
      entries: finalEntries
    };
    fs.writeFileSync(filePath, JSON.stringify(outputData, null, 2));
    console.log(`Successfully saved ${finalEntries.length} entries to ${filePath}`);

  } catch (error) {
    console.error('Error fetching feeds:', error);
    process.exit(1);
  }
}

main();
