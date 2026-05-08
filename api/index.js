const express = require('express');
const nodemailer = require('nodemailer');
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*'); 
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

app.use(express.json());

app.get('/', (req, res) => res.json({ status: "OK", message: "Webmail API 伺服器運作中！" }));

// --- 寄信 API ---
app.post('/api/send', async (req, res) => {
    const { user, pass, to, subject, text, html, smtpHost } = req.body;
    try {
        let transporter = nodemailer.createTransport({
            host: smtpHost || 'smtp.gmail.com', port: 465, secure: true,
            auth: { user, pass }
        });
        let info = await transporter.sendMail({
            from: user, to, subject, text, html: html || text.replace(/\n/g, '<br>') 
        });
        res.json({ success: true, messageId: info.messageId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- 刪除信件 API ---
app.post('/api/delete', async (req, res) => {
    const { user, pass, imapHost, uids } = req.body;
    if (!uids || !uids.length) return res.status(400).json({ success: false });
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uids, '\\Deleted');
        await connection.imap.expunge((err) => { if (err) throw err; });
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 標記已讀 API ---
app.post('/api/mark-read', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Seen');
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 標記已回覆 API ---
app.post('/api/mark-answered', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Answered');
        connection.end();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 收信 API (極速優化版) ---
app.post('/api/emails', async (req, res) => {
    const { user, pass, imapHost } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        const box = await connection.openBox('INBOX');
        
        // 【極速優化】直接計算總信件數，只精準抓取最後 30 封最新信件，不浪費時間掃描全庫
        const totalMessages = box.messages.total;
        if (totalMessages === 0) {
            connection.end();
            return res.json({ success: true, emails: [] });
        }
        
        const fetchStart = Math.max(1, totalMessages - 29); // 取得最後 30 封
        const searchCriteria = [ `${fetchStart}:*` ]; // 使用 Sequence Number 精準搜尋
        
        const messages = await connection.search(searchCriteria, { bodies: ['HEADER', 'TEXT', ''], markSeen: false });
        let parsedEmails = [];

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            const id = item.attributes.uid;
            const parsed = await simpleParser("Imap-Id: "+id+"\r\n" + all.body);
            const senderEmail = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].address : '未知寄件者';
            
            parsedEmails.push({
                id: id,
                subject: parsed.subject || '(無主旨)',
                sender: senderEmail,
                senderName: parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].name : senderEmail,
                body: parsed.text || '',
                html: parsed.html || parsed.textAsHtml || '', 
                bodySnippet: parsed.text ? parsed.text.substring(0, 50).replace(/\n/g, ' ') : '',
                timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
                read: item.attributes.flags.includes('\\Seen'),
                replied: item.attributes.flags.includes('\\Answered')
            });
        }
        connection.end();
        parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
        res.json({ success: true, emails: parsedEmails });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

module.exports = app;
