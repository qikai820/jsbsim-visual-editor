"""Synthetic acceptance/evidence tests only; these do not demonstrate real flight."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('joint',Path(__file__).resolve().parents[1]/'scripts/test-f450-hover.py')
joint=importlib.util.module_from_spec(spec);spec.loader.exec_module(joint)

def evidence():
    points=[]
    for i in range(301):
        v={'relative-alt-m':5.05,'local-x-m':0.,'local-y-m':0.,'roll-abs-deg':1.,'pitch-abs-deg':1.,'groundspeed-mps':.05,'climb-rate-mps':.01}
        points.append({'time':10+i*.1,'values':{'test/fc/'+k:value for k,value in v.items()}})
    report={'result':{'id':3,'status':'passed','dryRun':False,'binding':{'instance':1,'model':'F450_PX4'},'logs':[{'time':10,'message':'bhover_begin::HOVER_BEGIN'},{'time':40,'message':'bhover_end::HOVER_END'}],'values':{'test/fc/landed':1,'test/fc/armed':0}},'trace':points}
    scene=[{'time':10+i*.5,'timestamp':100+i*.5,'age_ms':20,'altitude_m':105.,'latitude_deg':34.,'longitude_deg':108.,'roll_deg':1.,'pitch_deg':1.,'groundspeed_mps':.05,'vertical_speed_mps':.01} for i in range(61)]
    return report,scene,{'altitude_m':100.}

class Acceptance(unittest.TestCase):
    def test_complete_evidence_passes(self):
        self.assertTrue(joint.evaluate(*evidence())['passed'])
    def test_single_excursion_fails(self):
        report,scene,ground=evidence();report['trace'][150]['values']['test/fc/relative-alt-m']=6.
        self.assertFalse(joint.evaluate(report,scene,ground)['passed'])
    def test_ideal_controller_cannot_hide_ground_truth_drift(self):
        report,scene,ground=evidence();scene[25]['latitude_deg']+=.0001
        self.assertFalse(joint.evaluate(report,scene,ground)['passed'])
    def test_stale_and_frozen_model_cannot_pass(self):
        for bad in ('age','clock'):
            report,scene,ground=evidence()
            if bad=='age':scene[25]['age_ms']=2000
            else:
                for sample in scene:sample['timestamp']=100
            self.assertFalse(joint.evaluate(report,scene,ground)['passed'])
    def test_missing_evidence_and_large_gaps_fail(self):
        report,scene,ground=evidence();del report['trace'][50:150]
        self.assertFalse(joint.evaluate(report,scene,ground)['passed'])
        report,scene,ground=evidence();del report['trace'][10]['values']['test/fc/local-y-m']
        self.assertFalse(joint.evaluate(report,scene,ground)['passed'])
    def test_dry_run_wrong_model_and_unconfirmed_landing_fail(self):
        for change in ('dryRun','model','armed'):
            report,scene,ground=evidence()
            if change=='dryRun':report['result']['dryRun']=True
            elif change=='model':report['result']['binding']['model']='other'
            else:report['result']['values']['test/fc/armed']=1
            self.assertFalse(joint.evaluate(report,scene,ground)['passed'])
    def test_preflight_rejects_external_or_unready_targets(self):
        with self.assertRaises(joint.Blocked):joint.check_preflight({'localSimulation':{'active':False}})
        state={'localSimulation':{k:True for k in ('active','bundled','ready','serviceRunning','px4Running')},'connection':{'peer':'192.168.3.10:14553','connected':True,'fresh':True,'hil':True}}
        with self.assertRaises(joint.Blocked):joint.check_preflight(state)
    def test_preflight_accepts_verified_custom_local_simulation(self):
        state={'localSimulation':{'active':True,'bundled':False,'ready':True,'serviceRunning':True,'px4Running':True,'localPx4Matched':True},
               'connection':{'peer':'127.0.0.1:18570','connected':True,'fresh':True,'hil':True,'armed':False,
                             'values':{'test/fc/landed':1,'test/fc/local-x-m':0.,'test/fc/local-y-m':0.,'test/fc/relative-alt-m':0.}},
               'scene':[{'instance_id':'01','model':'F450_PX4','state':'running','age_ms':10,'altitude_m':285.}]}
        self.assertEqual(joint.check_preflight(state)['model'],'F450_PX4')
        for field in ('localPx4Matched','px4Running'):
            bad=copy.deepcopy(state);bad['localSimulation'][field]=False
            with self.assertRaises(joint.Blocked):joint.check_preflight(bad)
        bad=copy.deepcopy(state);bad['connection']['hil']=False
        with self.assertRaisesRegex(joint.Blocked,'commander start -h'):joint.check_preflight(bad)
        bad=copy.deepcopy(state);del bad['connection']['values']['test/fc/local-x-m']
        with self.assertRaisesRegex(joint.Blocked,'EKF'):joint.check_preflight(bad)
        with self.assertRaisesRegex(joint.Blocked,'缺少 localSimulation'):joint.check_preflight({})

if __name__=='__main__':unittest.main(verbosity=2)
