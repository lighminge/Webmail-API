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

// 增加 JSON 負載上限至 10MB，以容納附件資料
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.get('/', (req, res) => res.json({ status: "OK", message: "Webmail API 伺服器運作中！已啟用企業級連線管理。" }));

// --- 共用 IMAP 連線設定 (解決 Gmail 憑證與超時問題) ---
const getImapConfig = (user, pass, host) => ({
    imap: {
        user: user,
        password: pass,
        host: host || 'imap.gmail.com',
        port: 993,
        tls: true,
        // 加入 SNI 伺服器名稱與憑證放行，防止 Gmail 阻擋
        tlsOptions: { servername: host || 'imap.gmail.com', rejectUnauthorized: false },
        authTimeout: 20000, // 延長驗證時間至 20 秒
        connTimeout: 20000
    }
});

// --- 查詢信箱總數量 (防連線佔用版) ---
app.post('/api/emails/count', async (req, res) => {
    const { user, pass, imapHost } = req.body;
    let connection;
    try {
        connection = await imaps.connect(getImapConfig(user, pass, imapHost));
        const box = await connection.openBox('INBOX');
        const total = box.messages.total;
        res.json({ success: true, total });
    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    } finally {
        // 【重要修復】無論成功或失敗，強制關閉連線，防止 Gmail 15個連線數爆滿
        if (connection) connection.end();
    }
});

// --- 寄信 API (支援附件) ---
app.post('/api/send', async (req, res) => {
    const { user, pass, to, subject, text, html, smtpHost, attachments } = req.body;
    try {
        let transporter = nodemailer.createTransport({
            host: smtpHost || 'smtp.gmail.com', port: 465, secure: true,
            auth: { user, pass }
        });

        let mailOptions = {
            from: user, to, subject, text, html: html || text.replace(/\n/g, '<br>')
        };

        if (attachments && Array.isArray(attachments)) {
            mailOptions.attachments = attachments.map(att => ({
                filename: att.filename,
                content: att.content,
                encoding: 'base64',
                contentType: att.contentType
            }));
        }

        let info = await transporter.sendMail(mailOptions);
        res.json({ success: true, messageId: info.messageId });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/delete', async (req, res) => {
    const { user, pass, imapHost, uids } = req.body;
    if (!uids || !uids.length) return res.status(400).json({ success: false });
    let connection;
    try {
        connection = await imaps.connect(getImapConfig(user, pass, imapHost));
        await connection.openBox('INBOX');
        await connection.addFlags(uids, '\\Deleted');
        await connection.imap.expunge((err) => { if (err) throw err; });
        res.json({ success: true });
    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    } finally {
        if (connection) connection.end();
    }
});

app.post('/api/mark-read', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    let connection;
    try {
        connection = await imaps.connect(getImapConfig(user, pass, imapHost));
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Seen');
        res.json({ success: true });
    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    } finally {
        if (connection) connection.end();
    }
});

app.post('/api/mark-answered', async (req, res) => {
    const { user, pass, imapHost, uid } = req.body;
    let connection;
    try {
        connection = await imaps.connect(getImapConfig(user, pass, imapHost));
        await connection.openBox('INBOX');
        await connection.addFlags(uid, '\\Answered');
        res.json({ success: true });
    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    } finally {
        if (connection) connection.end();
    }
});

// --- 收信 API (終極安全版) ---
app.post('/api/emails', async (req, res) => {
    const { user, pass, imapHost, page = 1, limit = 30 } = req.body;
    let connection;
    try {
        connection = await imaps.connect(getImapConfig(user, pass, imapHost));
        const box = await connection.openBox('INBOX');
        const totalMessages = box.messages.total;

        if (totalMessages === 0) {
            return res.json({ success: true, emails: [], total: 0 });
        }

        const end = totalMessages - (page - 1) * limit;
        const start = Math.max(1, end - limit + 1);

        if (end < 1) {
            return res.json({ success: true, emails: [], total: totalMessages });
        }

        const targetUids = await new Promise((resolve, reject) => {
            const foundUids = [];
            const f = connection.imap.seq.fetch(`${start}:${end}`);
            f.on('message', (msg) => {
                msg.once('attributes', (attrs) => {
                    if (attrs && attrs.uid) {
                        foundUids.push(attrs.uid);
                    }
                });
            });
            f.once('error', (err) => reject(err));
            f.once('end', () => resolve(foundUids));
        });

        if (targetUids.length === 0) {
            return res.json({ success: true, emails: [], total: totalMessages });
        }

        const searchCriteria = [['UID', targetUids.join(',')]];
        const messages = await connection.search(searchCriteria, { bodies: ['HEADER', 'TEXT', ''], markSeen: false });
        let parsedEmails = [];

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            if (!all) continue;
            
            const id = item.attributes.uid;
            const parsed = await simpleParser("Imap-Id: "+id+"\r\n" + all.body);
            const senderEmail = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].address : '未知寄件者';

            let attachments = [];
            if (parsed.attachments && parsed.attachments.length > 0) {
                for (let att of parsed.attachments) {
                    if (att.size > 3 * 1024 * 1024) {
                        attachments.push({ filename: att.filename, contentType: att.contentType, size: att.size, error: true });
                    } else if (att.content) {
                        attachments.push({
                            filename: att.filename,
                            contentType: att.contentType,
                            size: att.size,
                            content: att.content.toString('base64')
                        });
                    }
                }
            }

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
                replied: item.attributes.flags.includes('\\Answered'),
                attachments: attachments
            });
        }
        
        parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
        res.json({ success: true, emails: parsedEmails, total: totalMessages });

    } catch (error) { 
        console.error("Fetch Error:", error);
        res.status(500).json({ success: false, error: error.message }); 
    } finally {
        if (connection) connection.end();
    }
});

module.exports = app;
