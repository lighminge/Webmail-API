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

app.get('/', (req, res) => res.json({ status: "OK", message: "Webmail API 伺服器運作中！支援附件收發。" }));

app.post('/api/emails/count', async (req, res) => {
    const { user, pass, imapHost } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 8000 } });
        const box = await connection.openBox('INBOX');
        const total = box.messages.total;
        connection.end();
        res.json({ success: true, total });
    } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// --- 寄信 API (全面支援附件) ---
app.post('/api/send', async (req, res) => {
    const { user, pass, to, subject, text, html, smtpHost, attachments } = req.body;
    try {
        let transporter = nodemailer.createTransport({
            host: smtpHost || 'smtp.gmail.com', port: 465, secure: true,
            auth: { user, pass }
        });

        let mailOptions = {
            from: user, 
            to, 
            subject, 
            text, 
            html: html || text.replace(/\n/g, '<br>')
        };

        // 如果前端有傳送附件，則動態加入 mailOptions
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
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

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

app.post('/api/emails', async (req, res) => {
    const { user, pass, imapHost, page = 1, limit = 30 } = req.body;
    try {
        const connection = await imaps.connect({ imap: { user, password: pass, host: imapHost || 'imap.gmail.com', port: 993, tls: true, authTimeout: 10000 } });
        const box = await connection.openBox('INBOX');
        const totalMessages = box.messages.total;

        if (totalMessages === 0) {
            connection.end();
            return res.json({ success: true, emails: [], total: 0 });
        }

        const end = totalMessages - (page - 1) * limit;
        const start = Math.max(1, end - limit + 1);

        if (end < 1) {
            connection.end();
            return res.json({ success: true, emails: [], total: totalMessages });
        }

        const searchCriteria = [ `${start}:${end}` ];
        const messages = await connection.search(searchCriteria, { bodies: ['HEADER', 'TEXT', ''], markSeen: false });
        let parsedEmails = [];

        for (let item of messages) {
            const all = item.parts.find(part => part.which === '');
            const id = item.attributes.uid;
            const parsed = await simpleParser("Imap-Id: "+id+"\r\n" + all.body);
            const senderEmail = parsed.from && parsed.from.value.length > 0 ? parsed.from.value[0].address : '未知寄件者';

            let attachments = [];
            if (parsed.attachments && parsed.attachments.length > 0) {
                attachments = parsed.attachments.map(att => {
                    if (att.size > 3 * 1024 * 1024) {
                        return { filename: att.filename, contentType: att.contentType, size: att.size, error: true };
                    }
                    return {
                        filename: att.filename,
                        contentType: att.contentType,
                        size: att.size,
                        content: att.content.toString('base64')
                    };
                });
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
        connection.end();
        parsedEmails.sort((a, b) => b.timestamp - a.timestamp);
        res.json({ success: true, emails: parsedEmails, total: totalMessages });

    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    }
});

module.exports = app;
