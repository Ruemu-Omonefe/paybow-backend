import type { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import config from '../config';
import { User } from '../models';
import type { AuthUser } from '../types';

export interface AuthedRequest extends Request {
  user: AuthUser & { email: string };
}

export function getDeviceId(req: Request): string | null {
  const deviceId = req.get('X-Device-Id');
  return deviceId && /^[A-Za-z0-9_-]{8,128}$/.test(deviceId) ? deviceId : null;
}

export async function claimDeviceSession(userId: unknown, deviceId: string, sessionId: string): Promise<boolean> {
  const user = await User.findOneAndUpdate(
    {
      _id: userId,
      status: 'active',
      $or: [{ activeDeviceId: deviceId }, { activeDeviceId: null }, { activeDeviceId: { $exists: false } }],
    },
    { $set: { activeDeviceId: deviceId, activeSessionId: sessionId } },
    { new: true }
  ).select('+activeDeviceId +activeSessionId').lean();
  return Boolean(user);
}

/** Authentication middleware: identifies the user from the Bearer token on every request. */
export async function authRequired(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    let payload: jwt.JwtPayload;
    try {
      payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    const deviceId = getDeviceId(req);
    if (!deviceId) return res.status(401).json({ error: 'Valid device ID required' });
    let user = await User.findById(payload.sub).select('+activeDeviceId +activeSessionId').lean();
    if (!user || user.status !== 'active') return res.status(401).json({ error: 'Account unavailable' });
    let sessionId = typeof payload.sid === 'string' ? payload.sid : null;
    if (!sessionId && !user.activeDeviceId && !user.activeSessionId) {
      sessionId = crypto.createHash('sha256').update(token).digest('hex');
      if (!(await claimDeviceSession(user._id, deviceId, sessionId))) {
        return res.status(401).json({ error: 'This account is active on another phone. Please log out there before signing in here.' });
      }
      user = await User.findById(payload.sub).select('+activeDeviceId +activeSessionId').lean();
    }
    if (!user || user.activeDeviceId !== deviceId || user.activeSessionId !== sessionId)
      return res.status(401).json({ error: 'This session is no longer active on this device. Please sign in again.' });
    (req as AuthedRequest).user = { id: String(user._id), name: user.name, email: user.email };
    next();
  } catch (e) {
    next(e);
  }
}

export const signToken = (userId: unknown, sessionId: string): string =>
  jwt.sign({ sub: String(userId), sid: sessionId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn } as jwt.SignOptions);
