import { DateTime } from 'luxon';

export type FirstTrainingDateReview = 'application_date_required' | 'application_date_invalid' | 'training_date_invalid' | 'outside_application_window' | 'weekday_conflict';
export type FirstTrainingDateResolution = { status:'resolved'; date:string; source:'explicit_year'|'application_relative'; applicationDate:string; latestAllowedDate:string }
  | { status:'review'; date:null; reason:FirstTrainingDateReview };
/** Civil dates only. No clock access: reruns cannot move a historical member into today's year. */
export function resolveFirstTrainingDate(input:{ applicationDate:string|null; month:number; day:number; explicitYear?:number; weekday?:number }):FirstTrainingDateResolution {
  const review=(reason:FirstTrainingDateReview):FirstTrainingDateResolution=>({status:'review',date:null,reason});
  if(!input.applicationDate)return review('application_date_required');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.applicationDate))return review('application_date_invalid');
  const application=DateTime.fromISO(input.applicationDate,{zone:'UTC'});
  if(!application.isValid||application.toISODate()!==input.applicationDate)return review('application_date_invalid');
  if(!Number.isInteger(input.month)||!Number.isInteger(input.day)||input.month<1||input.month>12||input.day<1||input.day>31
    ||input.explicitYear!==undefined&&(!Number.isInteger(input.explicitYear)||input.explicitYear<1||input.explicitYear>9999))return review('training_date_invalid');
  let year=input.explicitYear??application.year;
  if(input.explicitYear===undefined&&(input.month<application.month||input.month===application.month&&input.day<application.day))year++;
  const candidate=DateTime.fromObject({year,month:input.month,day:input.day},{zone:'UTC'});
  if(!candidate.isValid||candidate.year!==year||candidate.month!==input.month||candidate.day!==input.day)return review('training_date_invalid');
  const latest=application.plus({months:2});
  if(candidate<application||candidate>latest)return review('outside_application_window');
  if(input.weekday!==undefined&&(!Number.isInteger(input.weekday)||input.weekday<1||input.weekday>7||candidate.weekday!==input.weekday))return review('weekday_conflict');
  return {status:'resolved',date:candidate.toISODate()!,source:input.explicitYear===undefined?'application_relative':'explicit_year',
    applicationDate:input.applicationDate,latestAllowedDate:latest.toISODate()!};
}
