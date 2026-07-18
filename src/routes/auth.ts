import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import prisma from '../lib/prisma';
import { OtpRequestBody, OtpVerifyBody, PasswordLoginBody } from '../types';

const router = Router();

// POST /auth/otp/request
router.post('/otp/request', async (req: Request, res: Response) => {
  const { phone } = req.body as OtpRequestBody;

  if (!phone) {
    return res.status(400).json({ success: false, message: 'Phone number is required' });
  }

  const { error } = await supabase.auth.signInWithOtp({
    phone,
  });

  if (error) {
    return res.status(400).json({ success: false, message: error.message });
  }

  return res.json({ success: true, message: 'OTP sent successfully' });
});

// POST /auth/otp/verify
router.post('/otp/verify', async (req: Request, res: Response) => {
  const { phone, otp } = req.body as OtpVerifyBody;

  if (!phone || !otp) {
    return res.status(400).json({ success: false, message: 'Phone and OTP are required' });
  }

  const { data, error } = await supabase.auth.verifyOtp({
    phone,
    token: otp,
    type: 'sms',
  });

  if (error || !data.user) {
    return res.status(400).json({ success: false, message: error?.message || 'Invalid OTP' });
  }

  const supabaseUserId = data.user.id;

  // Sync with Prisma Database
  try {
    let user = await prisma.user.findUnique({
      where: { phone },
      include: { clientProfile: true },
    });

    if (!user) {
      // Auto-create a ClientProfile on first successful login if one doesn't exist
      user = await prisma.user.create({
        data: {
          id: supabaseUserId, // use same ID for easier mapping, or let prisma generate
          phone,
          role: 'CLIENT',
          clientProfile: {
            create: {} // creates an empty client profile
          }
        },
        include: { clientProfile: true }
      });
    }

    return res.json({
      success: true,
      token: data.session?.access_token,
      message: 'Login successful',
    });
  } catch (dbError: any) {
    console.error('Database error during OTP verify:', dbError);
    return res.status(500).json({ success: false, message: 'Internal server error during user sync' });
  }
});

// POST /auth/login/staff
router.post('/login/staff', async (req: Request, res: Response) => {
  const { email, password } = req.body as PasswordLoginBody;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error || !data.user) {
    return res.status(401).json({ success: false, message: error?.message || 'Invalid credentials' });
  }

  // Get user role from Prisma DB
  try {
    const dbUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true, role: true },
    });

    if (!dbUser || (dbUser.role !== 'AGENT' && dbUser.role !== 'ADMIN')) {
      return res.status(403).json({ success: false, message: 'Access denied: not a staff account' });
    }

    // Sync ID if it differs (first login after seed)
    if (dbUser.id !== data.user.id) {
      await prisma.user.update({
        where: { email },
        data: { id: data.user.id }
      });
    }

    return res.json({
      success: true,
      token: data.session?.access_token,
      role: dbUser.role,
      message: 'Staff login successful',
    });
  } catch (dbError: any) {
    console.error('Database error during staff login:', dbError);
    return res.status(500).json({ success: false, message: 'Internal server error during authorization' });
  }
});

export default router;
