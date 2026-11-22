// Validate compiler output with the actual FGScript implementation.
#include "FGFDMExec.h"
#include "input_output/FGScript.h"
#include "input_output/FGPropertyManager.h"
#include <cstdlib>
#include <iostream>
int main(int argc,char**argv){try{
  if(argc<4)return 2;
  JSBSim::FGFDMExec f;f.SetDebugLevel(0);f.SetRootDir(SGPath(argv[1]));f.SetAircraftPath(SGPath("aircraft"));f.SetEnginePath(SGPath("engine"));f.SetSystemsPath(SGPath("systems"));
  if(!f.LoadScript(SGPath(argv[2])))return 3;
  f.GetPropertyCatalog().clear();
  JSBSim::FGFDMExec::PropertyCatalogStructure pcs;pcs.base_string="";pcs.node=f.GetPropertyManager()->GetNode();f.BuildPropertyCatalog(&pcs);
  f.SetPropertyValue("test/runtime/ready",1);
  // The standalone FGScript check mocks bridge completion, so also provide
  // the read-only controller metrics used by completion notifications.
  if(std::getenv("FLIGHT_TEST_ACK_ANGLES"))f.GetPropertyManager()->GetNode("test/attitude/held-s",true)->setDoubleValue(0.);
  if(std::getenv("FLIGHT_TEST_ACK_MANUAL"))for(const auto* field:{"position-error-m","speed-mps","held-s"})
    f.GetPropertyManager()->GetNode(std::string("test/manual/")+field,true)->setDoubleValue(0.);
  if(std::getenv("FLIGHT_TEST_ACK_HEADING"))for(const auto* field:{"error-deg","held-s"})
    f.GetPropertyManager()->GetNode(std::string("test/heading/")+field,true)->setDoubleValue(0.);
  for(int i=3;i<argc;i++){const double t=std::atof(argv[i]);f.Setsim_time(t);if(!f.GetScript()->RunScript())return 4;
    if(std::getenv("FLIGHT_TEST_ACK_ANGLES")){
      for(const auto &item:f.GetPropertyCatalog()){
        auto name=item.substr(0,item.find(' '));const auto offset=name.find("test/input/");if(offset!=std::string::npos)name.erase(0,offset);const std::string suffix="/angle-pitch-deg";
        if(name.find("test/input/")==0&&name.size()>suffix.size()&&name.substr(name.size()-suffix.size())==suffix){
          const auto owner=name.substr(0,name.size()-suffix.size());
          if(f.GetPropertyValue(owner+"/enabled")==1.){
            std::cout<<"ANGLE "<<f.GetPropertyValue(owner+"/angle-roll-deg")<<' '<<f.GetPropertyValue(name)<<'\n';
            f.SetPropertyValue("test/attitude/"+owner.substr(11)+"/status",1.);
          }
        }
      }
    }
    if(std::getenv("FLIGHT_TEST_ACK_MANUAL")){
      for(const auto &item:f.GetPropertyCatalog()){
        auto name=item.substr(0,item.find(' '));const auto offset=name.find("test/input/");if(offset!=std::string::npos)name.erase(0,offset);const std::string suffix="/recover-reference";
        if(name.find("test/input/")==0&&name.size()>suffix.size()&&name.substr(name.size()-suffix.size())==suffix){
          const auto owner=name.substr(0,name.size()-suffix.size());
          if(f.GetPropertyValue(owner+"/enabled")==1.){
            std::cout<<"RECOVER "<<f.GetPropertyValue(name)<<'\n';
            f.SetPropertyValue("test/manual/"+owner.substr(11)+"/status",1.);
          }
        }
      }
    }
    if(std::getenv("FLIGHT_TEST_ACK_HEADING"))for(const auto &item:f.GetPropertyCatalog()){
      auto name=item.substr(0,item.find(' '));const auto offset=name.find("test/input/");if(offset!=std::string::npos)name.erase(0,offset);const std::string suffix="/heading-target-deg";
      if(name.find("test/input/")==0&&name.size()>suffix.size()&&name.substr(name.size()-suffix.size())==suffix){
        const auto owner=name.substr(0,name.size()-suffix.size());if(f.GetPropertyValue(owner+"/enabled")==1.){
          std::cout<<"HEADING "<<f.GetPropertyValue(name)<<'\n';f.SetPropertyValue("test/heading/"+owner.substr(11)+"/status",1.);
        }
      }
    }
    std::cout<<"STATE "<<t<<' '<<f.GetPropertyValue("test/runtime/complete");
    // Print each active lease; the property bridge composes the final axes.
    const auto catalog=f.GetPropertyCatalog();
    for(const auto&item:catalog){const auto name=item.substr(0,item.find(' '));if(name.find("test/input/")!=std::string::npos&&name.find("/enabled")!=std::string::npos&&f.GetPropertyValue(name)==1.)std::cout<<' '<<name;}
    std::cout<<'\n';
  }return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 5;}}
