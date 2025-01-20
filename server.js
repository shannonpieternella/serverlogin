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

// Middleware
app.use(bodyParser.json());
app.use(cors());

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

// Controleer actieve abonnementen via e-mailadres
const checkActiveSubscriptionByEmail = async (email) => {
    try {
        const customers = await stripe.customers.list({ email });
        if (customers.data.length === 0) {
            return false; // Geen klant gevonden
        }

        const customerId = customers.data[0].id;

        const subscriptions = await stripe.subscriptions.list({
            customer: customerId,
            status: "active",
        });

        return subscriptions.data.length > 0; // True als er een actieve abonnement is
    } catch (error) {
        console.error("Fout bij het controleren van abonnementen:", error);
        return false;
    }
};

// Create transporter object using Gmail's SMTP
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
    },
});

// Forgot Password Endpoint
app.post("/forgot-password", async (req, res) => {
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
        user.resetToken = resetToken;
        user.tokenExpiration = Date.now() + 3600000; // 1 hour from now
        await user.save();

        const resetLink = `http://localhost:3000/reset-password?token=${resetToken}`;
        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: email,
            subject: "Password Reset",
            html: `<p>Click the link below to reset your password:</p>
                   <a href="${resetLink}">${resetLink}</a>
                   <p>If you did not request this, please ignore this email.</p>`,
        };

        transporter.sendMail(mailOptions, (error, info) => {
            if (error) {
                console.error("Error sending email:", error);
                return res.status(500).json({ error: "Failed to send email. Please try again later." });
            }
            console.log("Password reset email sent:", info.response);
            res.status(200).json({ message: "Password reset link has been sent!" });
        });
    } catch (error) {
        console.error("Error in forgot-password endpoint:", error);
        res.status(500).json({ error: "Server error. Please try again later." });
    }
});

// Reset Password Endpoint
app.post("/reset-password", async (req, res) => {
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

// API-endpoint: Inloggen
app.post("/login", async (req, res) => {
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


// Start de server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server draait op http://localhost:${PORT}`));
