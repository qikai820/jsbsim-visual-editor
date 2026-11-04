#!/usr/bin/env python3
"""Build the editor's context-sensitive XML types from the owning JSBSim tree.

XSD supplies the grammar, not runtime defaults. Source-reader overlays take
precedence. --check detects parser/schema drift instead of silently trusting an
outdated global list. No files in the simulator repository are modified.
"""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path
import xml.etree.ElementTree as ET

BASE = Path(__file__).resolve().parents[1]
X = '{http://www.w3.org/2001/XMLSchema}'
NUMBERS = {'double', 'float', 'decimal', 'integer', 'int', 'unsignedInt', 'unsignedByte',
           'unsignedShort', 'long', 'short', 'byte', 'nonNegativeInteger', 'positiveInteger'}


def generate(source):
    declarations, groups, roots, rules, evidence = {}, {}, {}, {}, []
    element_ids = {}
    files = sorted(source.glob('*.xsd'))
    for path in files:
        tree = ET.parse(path).getroot()
        for node in tree:
            if node.tag in (X+'complexType', X+'simpleType'):
                declarations[node.get('name')] = node
            elif node.tag == X+'group':
                groups[node.get('name')] = node
            elif node.tag == X+'element':
                roots[node.get('name')] = node
    root_nodes = roots.copy()
    roots = {}

    def compile_type(name):
        if name in rules:
            return name
        rules[name] = {'text': 'string', 'children': {}, 'attributes': {}}
        if name.startswith('xs:'):
            rules[name]['text'] = 'number' if name[3:] in NUMBERS else 'string'
        elif name in declarations:
            compile_body(declarations[name], name)
        return name

    def element_type(node, owner):
        if id(node) in element_ids:
            return element_ids[id(node)]
        if node.get('ref'):
            return root_type(node.get('ref'))
        name = node.get('type')
        if name:
            return compile_type(name)
        name = owner + '/' + node.get('name', 'anonymous')
        element_ids[id(node)] = name
        if name not in rules:
            rules[name] = {'text': 'string', 'children': {}, 'attributes': {}}
            compile_body(node, name)
        return name

    def root_type(tag):
        if tag not in roots:
            node = root_nodes.get(tag)
            roots[tag] = node.get('type') or '$/'+tag if node is not None else '$'+tag
            if node is not None:
                roots[tag] = element_type(node, '$')
            else:
                compile_type(roots[tag])
        return roots[tag]

    def compile_body(node, owner, seen=()):
        rule = rules[owner]
        for child in node:
            tag = child.tag.removeprefix(X)
            if tag == 'annotation':
                continue
            if tag in ('extension', 'restriction') and child.get('base'):
                base = compile_type(child.get('base'))
                rule['text'] = rules[base]['text']
                rule['children'].update(rules[base]['children'])
                rule['attributes'].update(rules[base]['attributes'])
            if tag == 'union':
                kinds = [rules[compile_type(t)]['text'] for t in child.get('memberTypes', '').split()]
                rule['text'] = 'parameter' if 'number' in kinds else 'string'
            elif tag == 'list':
                rule['text'] = 'numbers' if rules[compile_type(child.get('itemType', 'xs:string'))]['text'] == 'number' else 'string'
            elif tag == 'element':
                key = child.get('name') or child.get('ref')
                rule['children'][key] = element_type(child, owner)
            elif tag == 'attribute':
                key = child.get('name')
                if key:
                    kind = rules[compile_type(child.get('type', 'xs:string'))]['text']
                    rule['attributes'][key] = kind
            elif tag == 'group' and child.get('ref'):
                ref = child.get('ref')
                if ref not in seen:
                    compile_body(groups[ref], owner, (*seen, ref))
            else:
                compile_body(child, owner, seen)

    for tag in root_nodes:
        root_type(tag)
    for name in declarations:
        compile_type(name)

    def ensure(path):
        parts = path.split('/')
        if parts[0] not in roots:
            roots[parts[0]] = compile_type('$'+parts[0])
        state = roots[parts[0]]
        for tag in parts[1:]:
            child = rules[state]['children'].get(tag)
            if not child:
                child = compile_type(state+'/'+tag)
                rules[state]['children'][tag] = child
            state = child
        return rules[state]

    def text(path, kind='number', origin=''):
        ensure(path)['text'] = kind
        if origin:
            evidence.append({'path': path, 'kind': kind, 'source': origin})

    def attr(path, name, kind='number', origin=''):
        ensure(path)['attributes'][name] = kind
        if origin:
            evidence.append({'path': path+'/@'+name, 'kind': kind, 'source': origin})

    def link(path, state):
        parent, tag = path.rsplit('/', 1)
        ensure(parent)['children'][tag] = compile_type(state)

    # A standalone projection is also used for reviewing and patching subtrees.
    for tag, state in {'function': 'model-function', 'table': 'table', 'tableData': 'table-data',
                       'location': 'location', 'orient': 'orientation', 'orientation': 'orientation',
                       'value': 'xs:double', 'v': 'xs:double', 'property': 'property', 'p': 'property-name',
                       'output': 'output', 'force': 'force', 'moment': 'moment',
                       'gas_cell': 'gas-cell', 'ballonet': 'ballonet',
                       'alphalimits': 'angle-range', 'hysteresis_limits': 'angle-range',
                       'range': 'range'}.items():
        roots[tag] = compile_type(state)

    # Literal numeric reads: one owning class per model/engine. Nested receivers
    # are explicitly routed below; this never installs global numeric tag names.
    owners = {
        'FGInitialCondition': ['initialize'], 'FGInertial': ['planet'], 'FGAircraft': ['metrics'], 'FGScript': ['event'],
        'FGPropulsion': ['propulsion'], 'FGMSIS': ['atmosphere'],
        'FGBrushLessDCMotor': ['brushless_dc_motor'], 'FGElectric': ['electric_engine'],
        'FGPiston': ['piston_engine'], 'FGPropeller': ['propeller'], 'FGRocket': ['rocket_engine'],
        'FGTurbine': ['turbine_engine'], 'FGTurboProp': ['turboprop_engine'], 'FGNozzle': ['nozzle'],
        'FGRotor': ['rotor'], 'FGTank': ['tank'], 'FGGasCell': ['gas_cell', 'ballonet'],
        'FGLGear': ['contact'], 'FGMassBalance': ['mass_balance'],
        'FGLinearActuator': ['linear_actuator'], 'FGDeadBand': ['deadband'],
        'FGSummer': ['summer'], 'FGActuator': ['actuator'],
        'FGSensor': ['sensor', 'gyro', 'accelerometer', 'magnetometer'],
        'FGKinemat': ['setting'], 'FGGain': ['domain', 'range'],
        'FGAerodynamics': ['alphalimits', 'hysteresis_limits'], 'FGTrimAnalysis': ['search'],
    }
    nested = {
        ('FGMassBalance', 'weight'): ['pointmass'], ('FGMassBalance', 'radius'): ['pointmass/form'],
        ('FGMassBalance', 'length'): ['pointmass/form'],
        ('FGTank', 'length'): ['tank/grain_config'], ('FGTank', 'bore_diameter'): ['tank/grain_config'],
        ('FGRocket', 'thrust'): ['rocket_engine/variation'], ('FGRocket', 'total_isp'): ['rocket_engine/variation'],
        ('FGSensor', 'bits'): ['quantization'], ('FGSensor', 'min'): ['quantization'], ('FGSensor', 'max'): ['quantization'],
    }
    call_inventory = []
    reader = re.compile(r'\b(FindElementValueAs(?:Number(?:Convert(?:FromTo|To))?|Boolean))\s*\(\s*"([^"]+)"')
    code_files = sorted((source/'src').rglob('*.cpp')) + sorted((source/'src').rglob('*.h'))
    for path in code_files:
        code = path.read_text(errors='replace')
        relative = path.relative_to(source).as_posix()
        for match in reader.finditer(code):
            if path.stem == 'FGXMLElement':
                continue
            tag = match[2]
            targets = nested.get((path.stem, tag), owners.get(path.stem))
            if not targets:
                raise RuntimeError(f'Unclassified numeric reader {relative}:{tag}; add its owner')
            origin = f'{relative}:{code.count(chr(10), 0, match.start())+1}'
            for owner in targets:
                text(owner+'/'+tag, origin=origin)
                attr(owner+'/'+tag, 'dispersion', origin=origin)
            call_inventory.append({'source': origin, 'reader': match[1], 'field': tag, 'owners': targets})

    rotor = (source/'src/models/propulsion/FGRotor.cpp').read_text()
    for match in re.finditer(r'ConfigValue(?:Conv)?\s*\(\s*\w+\s*,\s*"([^"]+)"', rotor):
        text('rotor/'+match[1], origin='src/models/propulsion/FGRotor.cpp')
        attr('rotor/'+match[1], 'dispersion')

    # All vector consumers go through FindElementTripletConvertTo. x/y/z and
    # roll/pitch/yaw are the six supported names in that routine.
    for vector in ['location', 'orient', 'orientation', 'direction', 'pointing', 'drain_location',
                   'position', 'velocity', 'attitude_rate']:
        for component in ['x', 'y', 'z', 'roll', 'pitch', 'yaw']:
            text(vector+'/'+component, origin='src/input_output/FGXMLElement.cpp:585')
            attr(vector+'/'+component, 'dispersion')
        attr(vector, 'unit', 'string')
    for parent in ['initialize', 'child', 'contact', 'pointmass', 'thruster', 'engine', 'tank',
                   'gas_cell', 'ballonet', 'force', 'moment', 'accelerometer', 'magnetometer']:
        for vector in ['location', 'orient', 'orientation', 'direction', 'pointing', 'drain_location']:
            link(parent+'/'+vector, roots[vector])
    for vector in ['position', 'orientation', 'velocity', 'attitude_rate']:
        link('initialize/'+vector, roots[vector])
    for tag in ['running', 'nlf']:
        text('initialize/'+tag, origin='src/initialization/FGInitialCondition.cpp')
    for tag in ['latitude', 'longitude', 'radius', 'altitudeAGL', 'altitudeMSL']:
        text('initialize/position/'+tag, origin='src/initialization/FGInitialCondition.cpp')
    attr('initialize', 'version', origin='src/initialization/FGInitialCondition.cpp:1038')
    for tag in ['sense', 'p_factor']:
        text('thruster/'+tag, origin='src/models/propulsion/FGPropeller.cpp')
    text('engine/feed', origin='src/models/propulsion/FGEngine.cpp:275')
    text('contact/retractable', origin='src/models/FGLGear.cpp')

    # Runtime parameter-or-property readers, distinct from property-only paths.
    fcs_code = (source/'src/models/FGFCS.cpp').read_text()
    components = sorted(set(re.findall(r'(?:component|tag|comp|type)[\w_]*\s*==\s*"([\w_-]+)"', fcs_code, re.I)))
    components = sorted(set(components + ['summer', 'pure_gain', 'scheduled_gain', 'aerosurface_scale',
        'switch', 'kinematic', 'pid', 'integrator', 'lag_filter', 'lead_lag_filter', 'second_order_filter',
        'washout_filter', 'sensor', 'gyro', 'accelerometer', 'magnetometer', 'actuator', 'deadband',
        'fcs_function', 'angle', 'waypoint_distance', 'waypoint_heading', 'linear_actuator', 'distributor']))
    for component in components:
        ensure(component)
        for tag in ['input', 'output', 'init']:
            text(component+'/'+tag, 'string')
        text(component+'/delay', 'parameter', 'src/models/flight_control/FGFCSComponent.cpp:149')
        for tag in ['min', 'max']:
            text(component+'/clipto/'+tag, 'parameter', 'src/models/flight_control/FGFCSComponent.cpp:171')
        ensure(component+'/clipto')['attributes']['type'] = 'string'
        rules[roots['channel']]['children'][component] = roots[component]
    for component in ['pure_gain', 'scheduled_gain', 'aerosurface_scale']:
        text(component+'/gain', 'parameter', 'src/models/flight_control/FGGain.cpp:74')
    for component in ['lag_filter', 'lead_lag_filter', 'second_order_filter', 'washout_filter', 'integrator']:
        for i in range(1, 8):
            text(f'{component}/c{i}', 'parameter', 'src/models/flight_control/FGFilter.cpp:96')
    for tag in ['kp', 'ki', 'kd']:
        text('pid/'+tag, 'parameter', 'src/models/flight_control/FGPID.cpp')
    text('deadband/width', 'parameter', 'src/models/flight_control/FGDeadBand.cpp')
    for tag in ['lag', 'rate_limit']:
        text('actuator/'+tag, 'parameter', 'src/models/flight_control/FGActuator.cpp')
    for tag in ['set', 'reset', 'versus', 'bias']:
        text('linear_actuator/'+tag, 'parameter', 'src/models/flight_control/FGLinearActuator.cpp')
    for component in ['switch', 'distributor/case']:
        text(component+'/test', 'condition', 'src/math/FGCondition.cpp')
        # Recursion preserves logical grouping and order.
        state = ensure(component+'/test')
        state['children']['test'] = ensure(component)['children']['test']
        attr(component+'/test', 'value', 'parameter', 'src/models/flight_control/FGSwitch.cpp')
        attr(component+'/test', 'logic', 'string')
    attr('switch/default', 'value', 'parameter', 'src/models/flight_control/FGSwitch.cpp')
    text('distributor/case/property', 'string')
    attr('distributor/case/property', 'value', 'parameter', 'src/models/flight_control/FGDistributor.cpp')
    text('condition', 'condition', 'src/math/FGCondition.cpp')
    rules[roots['condition']]['children']['condition'] = roots['condition']
    attr('channel', 'execrate', origin='src/models/FGFCS.cpp:534')

    # Math expressions support more operations than the shipped XSD. Use the
    # actual operation dispatch names, preserving all argument order.
    function = (source/'src/math/FGFunction.cpp').read_text()
    operations = sorted(set(re.findall(r'operation\s*==\s*"([^"]+)"', function)))
    expression_children = {}
    for tag in operations:
        state = compile_type('$math/'+tag)
        expression_children[tag] = state
        if tag not in roots:
            roots[tag] = state
    for tag in ['value', 'v']:
        text(tag)
    for tag in ['property', 'p']:
        text(tag, 'string')
    expression_children.update({'value': compile_type('xs:double'), 'v': compile_type('xs:double'),
                                'property': compile_type('property'), 'p': compile_type('property')})
    ensure('tableData')['text'] = 'table'
    attr('tableData', 'breakPoint', origin='src/math/FGTable.cpp:373')
    ensure('tableData')['children']['tableData'] = roots['tableData']
    ensure('table')['children'].update({'tableData': roots['tableData'], 'independentVar': compile_type('property-name')})
    # independentVar needs attributes in addition to its property-only text.
    ensure('independentVar')['text'] = 'string'
    attr('independentVar', 'lookup', 'axis', 'src/math/FGTable.cpp')
    ensure('table')['children']['independentVar'] = roots['independentVar']
    expression_children['table'] = expression_children['t'] = roots['table']
    roots['t'] = roots['table']
    for tag, state in expression_children.items():
        if tag not in ['value', 'v', 'property', 'p', 'table', 't', 'pi', 'random', 'urandom']:
            rules[state]['children'].update(expression_children)
    for name in ['function', 'model-function']:
        rules[name]['children'].update(expression_children)
    for tag, fields in {'random': ['mean', 'stddev'], 'urandom': ['lower', 'upper']}.items():
        for field in fields:
            rules[expression_children[tag]]['attributes'][field] = 'number'
            evidence.append({'path':'function/'+tag+'/@'+field,'kind':'number','source':'src/math/FGFunction.cpp'})
        rules[expression_children[tag]]['attributes']['seed'] = 'atoi'
    for parent in ['axis', 'aerodynamics', 'fcs_function', 'force', 'moment', 'turbine_engine',
                   'turboprop_engine', 'piston_engine', 'electric_engine', 'rocket_engine', 'rotor',
                   'brushless_dc_motor', 'system', 'flight_control', 'autopilot']:
        link(parent+'/function', roots['function'])
        link(parent+'/table', roots['table'])
    for parent in ['turbine_engine', 'turboprop_engine']:
        for tag in ['tsfc', 'atsfc']:
            text(parent+'/'+tag, 'parameter', 'src/models/propulsion/FGTurbine.cpp')
            link(parent+'/'+tag+'/function', roots['function'])
    text('rocket_engine/isp', 'parameter')
    link('rocket_engine/isp/function', roots['function'])

    # All literal numeric attribute readers; owning tags are explicit because
    # e.g. fdm_config/@version is a string, initialize/@version is a number.
    attributes = {
        'src/input_output/FGHIL.cpp': {'input': ['port','baud'], 'output': ['port','baud','system_id','component_id','mavlink_version']},
        'src/input_output/FGOutputFG.cpp': {'output/time': ['resolution']},
        'src/input_output/FGOutputSocket.cpp': {'output': ['precision']},
        'src/input_output/FGOutputType.cpp': {'output': ['rate']},
        'src/input_output/FGPropertyReader.cpp': {},
        'src/input_output/FGScript.cpp': {'run': ['start','end','dt'], 'set': ['value','tc']},
        'src/input_output/FGViztraUdpOutput.cpp': {},
        'src/initialization/FGTrimAnalysis.cpp': {'search/tolerance':['value'], 'search/max_iterations':['value']},
        'src/models/propulsion/FGPropeller.cpp': {'propeller':['version']},
    }
    for filename, entries in attributes.items():
        for owner, fields in entries.items():
            for field in fields:
                attr(owner, field, origin=filename)
    attr('input', 'port', 'atoi', 'src/input_output/FGInputSocket.cpp:69')
    attr('input', 'rate', 'atoi', 'src/input_output/FGUDPInputSocket.cpp:68')
    attr('output', 'port', 'atoi', 'src/input_output/FGOutputSocket.cpp:105')
    attr('output', 'type', 'upper', 'src/models/FGOutput.cpp:314')
    attr('input', 'type', 'upper', 'src/models/FGInput.cpp:106')
    for owner in ['system', 'flight_control', 'autopilot', 'fdm_config', 'metrics', 'mass_balance',
                  'aerodynamics', 'ground_reactions', 'propulsion', 'planet']:
        text(owner+'/property', 'string')
        attr(owner+'/property', 'value', origin='src/input_output/FGPropertyReader.cpp:86')
    for tag in ['phi','theta','psi','gamma','nlf','throttle_cmd','elevator_cmd','rudder_cmd','aileron_cmd']:
        text('trim_config/'+tag, origin='src/initialization/FGTrimAnalysis.cpp:532')
        attr('trim_config/'+tag, 'step_size', origin='src/initialization/FGTrimAnalysis.cpp:603')
    link('trim_config/search', roots['search'])
    link('fdm_config/child', roots['child'])
    link('fdm_config/atmosphere', roots['atmosphere'])

    # Firmware XML sidecars have their own grammar and decimal readers.
    for root, child in [('pwm_inputs','input'), ('serial_outputs','output')]:
        # Do not reuse the aircraft <input>/<output> types.
        ensure(root)['children'][child] = compile_type('$'+root+'/'+child)
    for key in ['min_us','max_us','output_min','output_max','failsafe','timeout_ms']:
        attr('pwm_inputs/input', key, origin='platforms/nuttx/src/jsbsim/jsbsim_pwm_input.cpp')
    for key in ['baud','data_bits','stop_bits','rate','checksum_start']:
        attr('serial_outputs/output', key, origin='platforms/nuttx/src/jsbsim/jsbsim_serial_output.cpp')
    for key in ['value','scale','offset']:
        attr('serial_outputs/output/field', key, origin='platforms/nuttx/src/jsbsim/jsbsim_serial_output.cpp')
    for key in ['prefix','suffix']:
        attr('serial_outputs/output', key, 'hex')

    # Attach common nested contexts that are absent or outdated in the XSD.
    for root in ['fdm_config', 'system', 'flight_control', 'autopilot']:
        link(root+'/channel', roots['channel'])
    for tag in ['alphalimits','hysteresis_limits']:
        link('aerodynamics/'+tag, roots[tag])
    for parent in ['gas_cell', 'ballonet']:
        for tag in ['heat', 'flow_rate']:
            link(parent+'/'+tag+'/function', roots['function'])
    text('aerosurface_scale/zero_centered', 'string', 'src/models/flight_control/FGGain.cpp:107')
    text('initialize/trim', 'string', 'src/initialization/FGInitialCondition.cpp:1107')
    # Safe source-confirmed attribute defaults only. XSD defaults are not a
    # runtime contract (e.g. version chooses a parser and element presence can
    # enable a feature), so all other omitted attributes stay significant.
    rules[expression_children['random']]['defaults'] = {'mean': '0', 'stddev': '1'}
    rules[expression_children['urandom']]['defaults'] = {'lower': '-1', 'upper': '1'}
    rules[expression_children['random']]['defaultsWhenEmpty'] = True
    rules[expression_children['urandom']]['defaultsWhenEmpty'] = True
    ensure('pwm_inputs/input')['defaults'] = {'min_us':'1000','max_us':'2000','output_min':'-1','output_max':'1','failsafe':'0','timeout_ms':'500'}
    ensure('serial_outputs/output')['defaults'] = {'baud':'115200','data_bits':'8','stop_bits':'1','rate':'100','checksum_start':'0',
        'protocol':'CUSTOM','parity':'NONE','byte_order':'LITTLE','checksum':'NONE','prefix':'','suffix':''}
    ensure('serial_outputs/output/field')['defaults'] = {'scale':'1','offset':'0'}

    # Inventory every XML accessor in the owning source. Fail on newly added
    # numeric readers that have no owner, including attribute/dynamic readers.
    numeric_attributes = {
        'FGInitialCondition': ['version'], 'FGTrimAnalysis': ['value','step_size'],
        'FGHIL': ['port','baud','system_id','component_id','mavlink_version'],
        'FGOutputFG': ['resolution'], 'FGOutputSocket': ['precision'], 'FGOutputType': ['rate'],
        'FGPropertyReader': ['value'], 'FGScript': ['start','end','dt','value','tc'],
        'FGViztraUdpOutput': ['port'], 'FGXMLElement': ['dispersion'], 'FGTable': ['breakPoint'],
        'FGFCS': ['execrate'], 'FGPropeller': ['version'],
    }
    accessors = []
    methods = r'(?:Find(?:Next)?Element(?:Value(?:As(?:Number(?:Convert(?:FromTo|To))?|Boolean))?)?|FindElementTripletConvertTo|GetAttributeValue(?:AsNumber)?|GetDataAsNumber|GetDataLine)'
    for path in code_files:
        code = path.read_text(errors='replace')
        # Keep literals while removing comments, preserving offsets/line numbers.
        code = re.sub(r'"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/',
                      lambda m: re.sub(r'[^\n]', ' ', m[0]) if m[0].startswith(('/', '/*')) else m[0], code)
        for m in re.finditer(r'->\s*('+methods+r')\s*\(\s*("(?:\\.|[^"\\])*"|[^\),\n]*)', code):
            method, arg = m[1], m[2].strip()
            if method == 'GetAttributeValueAsNumber' and arg.startswith('"'):
                key = json.loads(arg)
                if key not in numeric_attributes.get(path.stem, []):
                    raise RuntimeError(f'Unclassified numeric attribute: {path}:{key}')
            accessors.append({'source':f'{path.relative_to(source)}:{code.count(chr(10),0,m.start())+1}',
                              'method':method,'argument':arg,
                              'policy':'typed numeric' if 'AsNumber' in method or 'AsBoolean' in method or 'Triplet' in method
                                       else 'grammar/context rule; preserve unknown strings and structure'})
    # No XSD defaults are applied: default presence can initialize properties,
    # enable features, select parser versions, or depend on other fields.
    for rule in rules.values():
        rule['children'] = dict(sorted(rule['children'].items()))
        rule['attributes'] = dict(sorted(rule['attributes'].items()))
        for state in rule['children'].values():
            if state not in rules:
                raise RuntimeError(f'Unresolved grammar reference: {state}')
    hashes = {str(p.relative_to(source)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in files + code_files + [source/'CMakeLists.txt',source/'platforms/nuttx/src/jsbsim/jsbsim_pwm_input.cpp',
                                            source/'platforms/nuttx/src/jsbsim/jsbsim_serial_output.cpp']}
    revision = subprocess.check_output(['git','rev-parse','HEAD'], cwd=source, text=True).strip()
    data = {'roots': dict(sorted(roots.items())), 'types': dict(sorted(rules.items()))}
    audit = {'revision': revision, 'files': hashes, 'accessors':accessors, 'numericReads': call_inventory, 'rules': evidence,
             'conservativeCorpusPolicies': [
               {'pattern':r'^system/description/', 'reason':'Documentation examples; not executable children', 'source':'src/models/FGFCS.cpp'},
               {'pattern':r'^fdm_config/fileheader/version$', 'reason':'Metadata string, not a numeric model parameter', 'source':'src/FGFDMExec.cpp:1317'},
               {'pattern':r'^flight_control/channel/summer/gain$', 'reason':'Summer reads bias; no gain reader', 'source':'src/models/flight_control/FGSummer.cpp'},
               {'pattern':r'^turboprop_engine/(milthrust|idlen2|maxn2|idlefuelflow)$', 'reason':'Legacy/obsolete fields not read as numeric parameters', 'source':'src/models/propulsion/FGTurboProp.cpp'},
               {'pattern':r'^nozzle/(pe|expr|nzl_eff|diam)$', 'reason':'Legacy nozzle fields; current loader reads area', 'source':'src/models/propulsion/FGNozzle.cpp'},
               {'pattern':r'^FDM_CONFIG/', 'reason':'Legacy uppercase grammar; opaque to current model loader', 'source':'src/FGFDMExec.cpp'},
               {'pattern':r'^plotset/', 'reason':'Plot tool document, not a flight-model configuration', 'source':'JSBSim.xsd'},
               {'pattern':r'^propeller/(p_factor|ctfactor|cpfactor)$', 'reason':'Mounting-only p_factor or old spellings; current coefficients use ct_factor/cp_factor', 'source':'src/models/propulsion/FGPropeller.cpp'},
               {'pattern':r'^rotor/(xhub|yhub|zhub|shafttilt|cantangle|cgroundeffect|tailrotor/)', 'reason':'Old rotor grammar; no current numeric reader', 'source':'src/models/propulsion/FGRotor.cpp'},
               {'pattern':r'^initialize/(position/altitude|velocity/(vn|ve|vd)|attitude/|rcengine)', 'reason':'Legacy initial-condition names, distinct from current x/y/z vectors and altitudeAGL/MSL', 'source':'src/initialization/FGInitialCondition.cpp'},
               {'pattern':r'^initialize/trim$', 'reason':'Literal trim-mode string, not floating-point data', 'source':'src/initialization/FGInitialCondition.cpp:1107'},
               {'pattern':r'^aerosurface_scale/zero_centered$|/aerosurface_scale/zero_centered$', 'reason':'Literal 0/false test; 0.0 does not have the same runtime meaning', 'source':'src/models/flight_control/FGGain.cpp:107'},
               {'pattern':r'^piston_engine/injected$', 'reason':'No injected parameter reader in current piston loader', 'source':'src/models/propulsion/FGPiston.cpp'},
               {'pattern':r'^(serial_outputs|pwm_inputs)/@version$', 'reason':'Reserved sidecar metadata, not parsed numerically', 'source':'platforms/nuttx/src/jsbsim/jsbsim_serial_output.cpp'},
             ],
             'dynamicReaders': ['FGParameterValue: numeric or property', 'FGCondition: property/operator/parameter lines',
               'FGFilter: c1..c7', 'FGRotor: ConfigValue/ConfigValueConv', 'Element: numeric vector components',
               'FGFunction: operation dispatch, random attributes', 'FGTrimAnalysis: named control fields',
               'FGTable: recursive numeric matrices and breakPoint', 'firmware: serial/PWM decimal and hex readers']}
    return data, audit


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=BASE.parent/'jsbsim_realtime')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    data, audit = generate(args.source.resolve())
    outputs = {
        BASE/'client/src/utils/jsbsimXmlSchema.generated.json': data,
        BASE/'tests/fixtures/jsbsim-xml-source-audit.json': audit,
    }
    for path, value in outputs.items():
        content = json.dumps(value, ensure_ascii=False, indent=2)+'\n'
        if args.check:
            if not path.exists() or path.read_text() != content:
                raise SystemExit(f'XML parser rules are stale: {path}; rerun {Path(__file__).name}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
    print(f'XML grammar: {len(data["types"])} contextual types, {len(data["roots"])} roots, '
          f'{len(audit["numericReads"])} literal numeric reads, {len(audit["files"])} source/schema hashes')
