// Laad vereiste modules
const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer");
const crypto = require("crypto"); // For generating a random token
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config(); // Laad .env-bestand

// Initialiseer Stripe met API-sleutel uit .env
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// Maak de Express-app
const app = express();

// CORS configureren
app.use(cors({
  origin: '*', // Sta alle domeinen toe
  methods: ['GET', 'POST', 'PUT', 'DELETE'], // Toestaan van specifieke HTTP-methoden
  allowedHeaders: ['Content-Type', 'Authorization'], // Specifieke headers toestaan
}));

// Andere middleware
app.use(express.json());

// Routes
app.get('/api/example', (req, res) => {
  res.json({ message: 'CORS werkt correct!' });
});
// MongoDB-verbinding
const mongoURI = "mongodb+srv://tradingviewsentinel:QrkpjJvX0PBnX0j2@sentinel.6czw8.mongodb.net/test?retryWrites=true&w=majority&appName=SENTINEL";

mongoose
    .connect(mongoURI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("Verbonden met MongoDB"))
    .catch((err) => console.error("Fout bij verbinden met MongoDB:", err));

// Mongoose-schema en -model voor gebruikers
const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    resetToken: { type: String },
    tokenExpiration: { type: Date },
});

const User = mongoose.model("User", userSchema);

// Mongoose-schema en -model voor TradeParameters
// Updated schema
const tradeParametersSchema = new mongoose.Schema({
    takeProfit1: { type: Number, required: true },
    takeProfit2: { type: Number, required: true },
    rewardRatios: { type: [String], default: ["1:2", "1:6"] },
    positionAllocation: {
        tp1: { type: Number, default: 0.7 },
        tp2: { type: Number, default: 0.3 }
    }
});

const TradeParameters = mongoose.model("TradeParameters", tradeParametersSchema);

// Functie om standaard TradeParameters in de database in te voegen bij serverstart (één keer)
const createDefaultTradeParameters = async () => {
    const existingTradeParams = await TradeParameters.find();
    if (existingTradeParams.length === 0) {
        // Als er geen tradeparameters zijn, voeg dan standaardgegevens toe
        const defaultTradeParams = new TradeParameters({
            stopLoss: 50,
            entryPrice: 100,
            takeProfit: 200,
        });
        await defaultTradeParams.save();
        console.log("Standaard tradeparameters toegevoegd");
    } else {
        console.log("Tradeparameters bestaan al in de database, geen actie nodig");
    }
};

// Voer de functie uit om tradeparameters toe te voegen bij het starten van de server
createDefaultTradeParameters();

// API-endpoint voor het ophalen van tradeparameters (GET)
app.get("/api/trading-parameters", async (req, res) => {
    try {
        // Haal alle tradeparameters op uit de database
        const tradeParams = await TradeParameters.find();

        // Als er geen tradeparameters zijn, geef dan een foutmelding
        if (tradeParams.length === 0) {
            return res.status(404).json({ error: "Geen tradeparameters gevonden" });
        }

        // Stuur de tradeparameters terug naar de client
        res.status(200).json(tradeParams);
    } catch (err) {
        res.status(500).json({ error: "Fout bij het ophalen van tradeparameters" });
    }
});



// Controleer actieve abonnementen via e-mailadres
const checkActiveSubscriptionByEmail = async (email) => {
    try {
        const customers = await stripe.customers.list({ email });
        if (customers.data.length === 0) {
            return false; // No customer found
        }

        const customerId = customers.data[0].id;

        // Fetch all subscriptions for the customer
        const subscriptions = await stripe.subscriptions.list({
            customer: customerId,
        });

 // Check for active subscriptions or trial subscriptions
        const hasActiveOrTrialSubscription = subscriptions.data.some((subscription) => {
            return (
                subscription.status === "active" || // Active subscriptions
                (subscription.trial_end && subscription.trial_end > Math.floor(Date.now() / 1000)) // Trial subscriptions
            );
        });

        return hasActiveOrTrialSubscription; // Return true if any condition is met
    } catch (error) {
        console.error("Error checking subscriptions:", error);
        return false; // Handle errors gracefully
    }
};

const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587, // Use 587 for STARTTLS
    secure: false, // Must be false for port 587
    auth: {
        user: process.env.GMAIL_USER, // Set in your .env file
        pass: process.env.GMAIL_PASS, // Set in your .env file (use app password if 2FA is enabled)
    },
    tls: {
        rejectUnauthorized: false, // Optional, use if you're facing certificate issues
    },
})

// Forgot Password Endpoint
app.post("/api/forgot-password", async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: "Email is required" });
    }

    try {
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(404).json({ error: "User not found" });
        }

        const resetToken = crypto.randomBytes(32).toString("hex");
        user.resetToken = resetToken; // Save token
        user.tokenExpiration = Date.now() + 3600000; // Token valid for 1 hour
        await user.save(); // Save user with token to database

        const resetLink = `https://app.tradingvisualizer.com/reset-password?token=${resetToken}`;
        const mailOptions = {
            from: `"Trade Visualizer" <${process.env.GMAIL_USER}>`,
            to: email,
            subject: "Password Reset Request",
            html: `<p>You requested a password reset.</p>
                   <p>Click this link to reset your password: <a href="${resetLink}">${resetLink}</a></p>`,
        };

        const info = await transporter.sendMail(mailOptions);
        console.log("Email sent: ", info.response);

        res.status(200).json({ message: "Password reset link sent to your email." });
    } catch (error) {
        console.error("Error sending email: ", error);
        res.status(500).json({ error: "Failed to send email. Please try again later." });
    }
});

// Reset Password Endpoint
app.post("/api/reset-password", async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ error: "Token and new password are required" });
    }

    try {
        const user = await User.findOne({
            resetToken: token,
            tokenExpiration: { $gt: Date.now() },
        });

        if (!user) {
            return res.status(400).json({ error: "Invalid or expired token" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.resetToken = undefined;
        user.tokenExpiration = undefined;
        await user.save();

        res.status(200).json({ message: "Password reset successfully" });
    } catch (error) {
        console.error("Error in reset-password endpoint:", error);
        res.status(500).json({ error: "Server error. Please try again later." });
    }
});

// API-endpoint: Registreren
app.post("/api/register", async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: "Email en wachtwoord zijn verplicht" });
    }

    try {
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: "Gebruiker bestaat al" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const user = new User({ email, password: hashedPassword });
        await user.save();

        res.status(201).json({ message: "Gebruiker succesvol geregistreerd" });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Serverfout" });
    }
});

// API-endpoint: Inloggen
app.post("/api/login", async (req, res) => {
    const { email, password } = req.body;

    try {
        const user = await User.findOne({ email });

        if (!user) {
            return res.status(400).json({ error: "Ongeldige inloggegevens" });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).json({ error: "Ongeldige inloggegevens" });
        }

        const hasActiveSubscription = await checkActiveSubscriptionByEmail(email);

        if (hasActiveSubscription) {
            console.log("Gebruiker heeft een actieve subscriptie.");
            return res.status(200).json({
                message: "Ingelogd!",
                hasActiveSubscription: true,
            });
        } else {
            console.log("Gebruiker heeft geen actieve subscriptie.");
            return res.status(200).json({
                message: "Ingelogd, maar geen actieve subscriptie gevonden.",
                hasActiveSubscription: false,
            });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Serverfout" });
    }
});

// Fetch Trade Parameters
app.get("/api/trade-parameters", async (req, res) => {
    try {
        const tradeParameters = await mongoose.connection.db
            .collection("tradeparameters")
            .findOne({});
        res.status(200).json(tradeParameters);
    } catch (error) {
        console.error("Error fetching trade parameters:", error);
        res.status(500).json({ error: "Failed to fetch trade parameters" });
    }
});

// Update Trade Parameters
app.put("/api/trade-parameters", async (req, res) => {
    const { stopLoss, entryPrice, takeProfit, biasTrend } = req.body;

    try {
        const result = await mongoose.connection.db
            .collection("tradeparameters")
            .updateOne({}, { $set: { stopLoss, entryPrice, takeProfit, biasTrend } });

        res.status(200).json({ message: "Trade parameters updated successfully" });
    } catch (error) {
        console.error("Error updating trade parameters:", error);
        res.status(500).json({ error: "Failed to update trade parameters" });
    }
});

// Fetch Prompt
app.get("/api/prompt", async (req, res) => {
    try {
        const prompt = await mongoose.connection.db
            .collection("prompts")
            .findOne({});
        res.status(200).json(prompt);
    } catch (error) {
        console.error("Error fetching prompt:", error);
        res.status(500).json({ error: "Failed to fetch prompt" });
    }
});

// Update Prompt
app.put("/api/prompt", async (req, res) => {
    const { content } = req.body;

    try {
        const result = await mongoose.connection.db
            .collection("prompts")
            .updateOne({}, { $set: { content } });

        res.status(200).json({ message: "Prompt updated successfully" });
    } catch (error) {
        console.error("Error updating prompt:", error);
        res.status(500).json({ error: "Failed to update prompt" });
    }
});

// Function to send signals to Discord
app.post("/api/discord-signal", async (req, res) => {
    const { stopLoss, entryPrice, takeProfit, biasTrend } = req.body;

    const webhookUrl = "https://discord.com/api/webhooks/1331012585436217395/S2L0gBXa-VowUsePViQa-vTOPpwoLA8kC5MGKkOJk56vuREef_0Ap9EhXFkCDP9VHvhF";
    
    try {
        await axios.post(webhookUrl, {
            content: `🚨 **Trade Signal** 🚨\n
            Stop Loss: ${stopLoss}\n
            Entry Price: ${entryPrice}\n
            Take Profit: ${takeProfit}\n
            Bias Trend: ${biasTrend}`,
        });
        res.status(200).json({ message: "Signal sent to Discord successfully!" });
    } catch (error) {
        console.error("Error sending signal to Discord:", error);
        res.status(500).json({ error: "Failed to send signal to Discord" });
    }
});

app.post("/api/tradingview-webhook", async (req, res) => {
    const { entryPrice, stopLoss, signalType } = req.body;
    const webhookUrl = "https://discord.com/api/webhooks/1331012585436217395/S2L0gBXa-VowUsePViQa-vTOPpwoLA8kC5MGKkOJk56vuREef_0Ap9EhXFkCDP9VHvhF";

 // Validate inputs
    if (!entryPrice || !stopLoss || !signalType) {
        return res.status(400).json({ error: "Missing required parameters" });
    }

    try {
        // Convert and validate numbers
        const entry = parseFloat(entryPrice);
        const sl = parseFloat(stopLoss);
        const direction = signalType.toUpperCase();

        if (isNaN(entry) || isNaN(sl)) {
            return res.status(400).json({ error: "Invalid numeric values" });
        }

        // Calculate risk and targets
        const risk = Math.abs(entry - sl);
        const tp1 = direction === 'BUY' 
            ? entry + (risk * 2)  // 1:2 RR
            : entry - (risk * 2);

        const tp2 = direction === 'BUY' 
            ? entry + (risk * 6)  // 1:6 RR
            : entry - (risk * 6);

        // Database update
        await mongoose.connection.db.collection("tradeparameters").updateOne(
            {},
            { 
                $set: { 
                    entryPrice: entry,
                    stopLoss: sl,
                    takeProfit1: tp1,
                    takeProfit2: tp2,
                    signalType: direction,
                    riskAmount: risk,
                    rewardRatios: ["1:2", "1:6"],
                    timestamp: new Date()
                } 
            },
            { upsert: true }
        );

// Generate trading plan prompt
        const promptContent = `🚀 **${direction} Trade Alert** 🚀\n\n` +
        `📍 **Entry Price:** ${entry.toFixed(5)}\n` +
        `⛔ **Stop Loss:** ${sl.toFixed(5)}\n` +
        `🎯 **Take Profit 1:** ${tp1.toFixed(5)}\n` +
        `🎯 **Take Profit 2:** ${tp2.toFixed(5)}\n\n` +
        `---\n\n` +
        `**Professional Trading Assistant and Mentor**\n\n` +
        `✅ Strictly follow the given trading signal. No independent analysis.\n` +
        `✅ Provide real-time guidance based on NASDAQ-100 chart updates.\n` +
        `✅ Offer professional trade progression updates.\n` +
        `✅ Recognize winning and losing trades and provide psychological support.\n\n` +
        `**Trade Progress Updates:**\n` +
        `- If price moves towards TP1: Reinforce confidence, explain momentum.\n` +
        `- If TP1 is reached: Secure profits and adjust stop loss.\n` +
        `- If price moves towards SL: Maintain emotional stability, trust the system.\n` +
        `- If SL is hit: Losses are part of professional trading. Stay focused.\n\n` +
        `**Trading Psychology & Emotional Support:**\n` +
        `- Stay disciplined. Losses are expected.\n` +
        `- Long-term strategy matters, not individual trades.\n` +
        `- Patience and risk management lead to success.`;


        await mongoose.connection.db.collection("prompts").updateOne(
            {},
            { $set: { 
                content: promptContent,
                strategy: "Tiered Risk-Reward",
                updatedAt: new Date() 
            } },
            { upsert: true }
        );


        // Format Discord message
        const discordMessage = {
            content: `🚀 **${direction} ALERT** 🚀
            \n**Entry**: \`${entry.toFixed(5)}\`
            \n**Stop Loss**: \`${sl.toFixed(5)}\`
            \n**Risk**: \`${risk.toFixed(5)}\`
            \n✅ **TP1 (1:2)**: \`${tp1.toFixed(5)}\`
            \n🎯 **TP2 (1:6)**: \`${tp2.toFixed(5)}\`
            \n📌 *Strategy: Split position 70/30 between TP1/TP2. Secure profits at TP1, trail TP2 with breakeven stop*`
        };

        await axios.post(webhookUrl, discordMessage);

        res.status(200).json({
            status: "success",
            tradePlan: {
                entry: entry,
                stopLoss: sl,
                takeProfit1: tp1,
                takeProfit2: tp2,
                riskRewardRatios: {
                    tp1: "1:2",
                    tp2: "1:6"
                },
                positionSizing: {
                    tp1_allocation: "70%",
                    tp2_allocation: "30%"
                }
            }
        });

    } catch (error) {
        console.error("Webhook processing error:", error);
        res.status(500).json({ 
            error: "Server Error",
            details: error.message,
            solution: "Check number formatting and webhook URL" 
        });
    }
});


// Start de server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server draait op http://localhost:${PORT}`));


