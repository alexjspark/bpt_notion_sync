import { NextResponse,type NextRequest } from 'next/server';
import { phase2Boundary } from './lib/team-boundary.ts';
export function proxy(request:NextRequest){
 const action=phase2Boundary(request.nextUrl.pathname,process.env.PHASE2_ENABLED==='true');
 if(action==='block')return NextResponse.json({code:'DISABLED'},{status:404,headers:{'Cache-Control':'no-store'}});
 if(action==='redirect')return NextResponse.redirect(new URL('/team',request.url));
 return NextResponse.next();
}
export const config={matcher:['/((?!_next/static|_next/image|favicon.ico).*)']};
